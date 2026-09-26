// SPDX-License-Identifier: MIT

/**
 * Executor: orchestrates the two settlement legs of a fill.
 *
 * 1. Calls EVM escrow `lock` to lock source funds
 * 2. Calls Soroban `fill_intent` (deliver + dispatch) to deliver destination
 *    assets and push the FillConfirmed message back to the source chain
 * 3. Tracks settlement status via the Soroban `status` view and handles
 *    idempotent retries so a settled intent is never filled twice
 */

import { createPublicClient, createWalletClient, http, type Account, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  SorobanRpc,
  TransactionBuilder,
  Keypair,
  Contract,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { PerihelionEscrowClient } from "@perihelion/sdk";
import type { SignedIntent, Intent } from "@perihelion/sdk";

/** Logger interface for structured logging. */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Configuration for the executor (keys and RPC endpoints).
 *
 * Environment variables under `PERIHELION_*` and `STELLAR_NETWORK` map onto
 * these fields through {@link loadExecutorConfig}.
 */
export interface ExecutorConfig {
  /** EVM RPC URL (Ethereum, Base, etc.) */
  readonly evmRpcUrl: string;
  /** Soroban RPC URL */
  readonly sorobanRpcUrl: string;
  /** EVM private key (hex-encoded with 0x prefix) */
  readonly evmPrivateKey: Hex;
  /** Soroban secret key (Stellar strkey) */
  readonly sorobanSecretKey: string;
  /** EVM escrow contract address */
  readonly escrowAddress: `0x${string}`;
  /** Soroban settlement contract ID (hash) */
  readonly settlementContractId: string;
  /** Source chain ID (1=mainnet, 8453=Base, etc.) */
  readonly sourceChainId: number;
  /** Stellar network passphrase (e.g. "Test SDF Network ; September 2015"). */
  readonly stellarNetwork: string;
}

/**
 * Idempotency check result returned by {@link Executor.checkFillStatus}.
 *
 * - `{ filled: true, settlementTx }` → the intent is settled; skip re-filling
 * - `{ filled: false }`              → genuinely not settled; proceed with fill
 * - `{ unknown: true }`              → status query failed; do NOT proceed
 */
export interface FillStatus {
  filled: boolean;
  unknown?: boolean;
  settlementTx?: string;
}

/**
 * Thrown (or re-thrown) by an executor when a fill has *definitively* failed — i.e.
 * the on-chain transaction was rejected or reverted — and the capital was never
 * committed. The solver catches this specifically in {@link Solver.consider} and
 * immediately releases the in-flight reservation.
 *
 * Contrast with a generic `Error` or a timeout, where the transaction may have
 * already landed (or may still land), so the reservation must be held until the
 * next inventory refresh to avoid double-spending.
 */
export class DefiniteFailureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DefiniteFailureError";
  }
}

/** How many times to poll for a Soroban transaction confirmation before giving up. */
const SOROBAN_MAX_POLL_ATTEMPTS = 30;
const SOROBAN_POLL_INTERVAL_MS = 2_000;

/** Minimum LayerZero lz_fee (stroops) accepted for a FillConfirmed message. */
const MIN_FILL_CONFIRMED_LZ_FEE = 1_000n;

/**
 * Execute a fill by orchestrating EVM lock and Soroban fill_intent.
 *
 * Handles idempotent retries: the current settlement state is read before
 * work starts, and the real on-chain settlement transaction hash is returned  * once both legs are done.
  */

export class Executor {
  private readonly evmRpcUrl: string;
  private readonly sorobanRpcUrl: string;
  private readonly evmPrivateKey: Hex;
  private readonly sorobanSecretKey: string;
  private readonly escrowAddress: `0x${string}`;
  private readonly settlementContractId: string;
  private readonly sourceChainId: number;
  private readonly stellarNetwork: string;
  private readonly logger: Logger;

  constructor(config?: ExecutorConfig, logger: Logger = console) {
    this.evmRpcUrl = config?.evmRpcUrl ?? "";
    this.sorobanRpcUrl = config?.sorobanRpcUrl ?? "";
    this.evmPrivateKey = config?.evmPrivateKey ?? ("0x" as Hex);
    this.sorobanSecretKey = config?.sorobanSecretKey ?? "";
    this.escrowAddress = config?.escrowAddress ?? ("0x" as `0x${string}`);
    this.settlementContractId = config?.settlementContractId ?? "";
    this.sourceChainId = config?.sourceChainId ?? 0;
    this.stellarNetwork = config?.stellarNetwork ?? "";
    this.logger = logger;
  }

  /**
   * Fill an intent: lock source funds, deliver destination assets, dispatch
   * FillConfirmed, then return the real settlement transaction hash and any
   * fees collected by the leg.
   *
   * Idempotent: if the intent is already settled, the existing settlement
   * transaction hash is returned without touching the chains.
   */
  async fill(signed: SignedIntent): Promise<{
    settlementTx: string;
    fees?: {
      sourceGasWei: bigint;
      lzFeeWei: bigint;
      stellarFeeStroops: bigint;
    };
  }> {
    const { hash } = signed;

    // Idempotency gate: read current settlement status before doing any work.
    const status = await this.checkFillStatus(hash);
    if (status.filled && status.settlementTx) {
      this.logger.info("intent already settled, skipping", { hash });
      return { settlementTx: status.settlementTx };
    }

    // Step 1: Lock source funds into the EVM escrow contract.
    const lockTx = await this.lockOnEvm(signed);
    this.logger.info("locked on EVM", { hash, lockTx });

    // Step 2: Deliver destination assets and dispatch FillConfirmed on
    // Soroban. `fill_intent` is a single atomic call: the funds land on
    // Stellar and the repayment message is dispatched in the same
    // transaction, so a single tx hash is the settlement proof.
    const settlementTx = await this.fillOnSoroban(signed, lockTx);
    this.logger.info("filled on Soroban", { hash, settlementTx });

    return { settlementTx };
  }

  /**
   * Check whether an intent has already been settled (idempotency check).
   *
   * Handles three mutually exclusive outcomes:
   * - `{ filled: true, settlementTx }`  → intent settled, skip re-fill
   * - `{ filled: false }`               → not settled, proceed with fill
   * - `{ unknown: true }`               → status query failed, do NOT proceed
   *
   * Unlike a past draft, this intentionally distinguishes a durable status
   * query failure from a genuinely unsettled intent. A transport/RPC error
   * must never be mistaken for "the intent has not been settled" — a
   * confidence check would silently skip work the sender still needs to
   * pay for. Failures therefore surface as `unknown: true` instead of
   * `{ filled: false }`.
   */
  async checkFillStatus(
    intentHash: Hex,
  ): Promise<{ filled: boolean; unknown?: boolean; settlementTx?: string }> {
    try {
      const settled = await this.isSettled(intentHash);
      if (settled) {
        // `isSettled` confirms the terminal Soroban state. Resolve the actual
        // settlement transaction hash by asking the escrow contract for the
        // lock record of this intent and reading `txHash`; that transaction
        // is the proof the FillConfirmed message was dispatched and the
        // solver was repaid.
        const lock = await this.getLock(intentHash);
        const settlementTx =
          lock?.txHash ?? (await this.fetchSettlementTxHash(intentHash));
        return { filled: true, settlementTx };
      }
      // `isSettled` returned false → intent is not yet settled.
      return { filled: false };
    } catch (err) {
      // Status query failure is a distinct outcome: treat as "unknown" so the
      // solver loop decides how to proceed instead of misreporting settled.
      this.logger.warn("status query failed during idempotency check", {
        hash: intentHash,
        error: err instanceof Error ? err.message : String(err),
      });
      return { filled: false, unknown: true };
    }
  }

  /**
   * Read the Soroban settlement contract's `status(intent_hash)` view.
   *
   * Soroban RPC exposes no direct "call a view" endpoint, so this simulates
   * a single-invocation transaction and decodes the return value.
   *
   * Returns true only for the terminal states (`Settled`, `Cancelled`,
   * `ConfirmationSent`). A non-terminal `Filled` result means the assets were
   * delivered but the confirmation message has not been dispatched yet, so
   * the fill is still in flight and `isSettled` must not return true.
   *
   * Throws on RPC/simulation failure so callers cannot conflate "not
   * settled" with "could not determine status".
   */
  async isSettled(intentHash: Hex): Promise<boolean> {
    const rpc = new SorobanRpc.Server(this.sorobanRpcUrl);
    const contract = new Contract(this.settlementContractId);

    const hashBytes = hexToBytes(intentHash);
    // Get a temporary account for the transaction builder.
    const keypair = Keypair.fromSecret("SCUU3GZO3AHY7QZB2BXLT27C2UV3OZPUWSP2JOWASAZJCJ2VZSGGLKJF");
    const account = await rpc.getAccount(keypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.stellarNetwork,
    })
      .addOperation(contract.call("status", xdr.ScVal.scvBytes(Buffer.from(hashBytes))))
      .setTimeout(30)
      .build();

    const simulated = await rpc.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationSuccess(simulated) || !simulated.result) {
      throw new Error("Settlement status query failed: RPC simulation error");
    }

    // Soroban enums decode either to a bare symbol string (e.g. "Settled")
    // or to a [tag, ...payload] vec; both carry the variant name in the
    // leading position.
    const native: unknown = scValToNative(simulated.result.retval);
    const variant =
      typeof native === "string"
        ? native
        : Array.isArray(native) && typeof native[0] === "string"
          ? native[0]
          : null;

    return (
      variant === "Settled" ||
      variant === "Cancelled" ||
      variant === "ConfirmationSent"
    );
  }

  /**
   * Lock the intent on EVM: the solver claims the intent, the escrow pulls
   * the user's pre-approved source funds, and the FillInstruction is dispatched
   * to Stellar.
   *
   * The SDK's `PerihelionEscrowClient` owns the ABI, address/dealer handling,
   * quote-and-buffer, and transaction plumbing, so this leg is a thin
   * orchestration layer over it.
   */
  async lockOnEvm(signed: SignedIntent): Promise<Hex> {
    const { intent, signature } = signed;

    const publicClient = createPublicClient({
      transport: http(this.evmRpcUrl),
    });

    const walletClient = createWalletClient({
      account: privateKeyToAccount(this.evmPrivateKey) as Account,
      transport: http(this.evmRpcUrl),
    });

    const escrowClient = new PerihelionEscrowClient(
      publicClient,
      walletClient,
      this.escrowAddress,
    );

    // Quote the native fee for the LayerZero send and pass it as msg.value.
    const nativeFee = await escrowClient.quoteFee(intent, undefined);

    // `lock` returns the on-chain transaction hash — the settlement proof for
    // this leg.
    return escrowClient.lock(intent, signature, nativeFee);
  }

  /**
   * Deliver the destination assets and dispatch the FillConfirmed message in
   * a single, atomic Soroban transaction.
   *
   * The settlement contract exposes two explicit entrypoints that mirror the
   * two concerns here:
   *
   * - `deliver_intent` sells the destination asset from the solver's inventory
   *   and marks the intent `Filled` (idempotency marker set)
   * - `dispatch_confirmation` pushes the `FillConfirmed` message to the source
   *   chain and marks the intent `ConfirmationSent`
   *
   * The contract ships a convenience wrapper `fill_intent(solver, solver_evm,
   * intent_hash, fill_amount, lz_fee)`, which this executor calls directly.
   * It atomically exercises both legs, collapses the two-transaction flow,
   * and lowers the risk of a solver crash leaving unlocked EVM funds. One
   * authoritative `send_fill_confirmed` runs, so the caller gets a single
   * settlement transaction hash.
   */
  async fillOnSoroban(signed: SignedIntent, _lockTx: Hex): Promise<Hex> {
    const { intent, hash: intentHash } = signed;

    const keypair = Keypair.fromSecret(this.sorobanSecretKey);
    const rpc = new SorobanRpc.Server(this.sorobanRpcUrl);
    const account = await rpc.getAccount(keypair.publicKey());

    const contract = new Contract(this.settlementContractId);

    // `status`/`fill_intent` take the raw 32-byte intent hash, so decode the
    // `0x`-prefixed hex string to `Uint8Array`.
    const hashBytes = hexToBytes(intentHash);

    // `solver_evm` is the signer's EVM address nudged into the 32-byte
    // `BytesN<32>` the contract enforces. The payout logic examines the
    // first 20 bytes of the value, so the address is left-justified.
    const solverEvmBytes = evmAddressTo32Bytes(
      privateKeyToAccount(this.evmPrivateKey).address,
    );

    // `fill_amount` is the minimum amount the solver must deliver, expressed
    // as i128. The contract rejects anything below `min_dest_amount`.
    const fillAmount = BigInt(intent.minDestAmount);

    // Quote the LayerZero fee before submission and require the minimum from
    // the endpoint. The quote is the same `quote_fill_confirmed_fee` style
    // call the delivery layer uses for the outbound message.
    const lzFee = await this.quoteFillConfirmedFee(
      this.settlementContractId,
      this.sorobanSecretKey,
      this.sorobanRpcUrl,
    );

    const args = [
      nativeToScVal(keypair.publicKey(), { type: "address" }), // solver
      xdr.ScVal.scvBytes(Buffer.from(solverEvmBytes)), // solver_evm: BytesN<32>
      xdr.ScVal.scvBytes(Buffer.from(hashBytes)), // intent_hash: BytesN<32>
      nativeToScVal(fillAmount, { type: "i128" }), // fill_amount: i128
      nativeToScVal(lzFee, { type: "i128" }), // lz_fee: i128
    ];

    const tx = new TransactionBuilder(account, {
      fee: "10000",
      networkPassphrase: this.stellarNetwork,
    })
      .addOperation(contract.call("fill_intent", ...args))
      .setTimeout(60)
      .build();

    // Simulate first to obtain the resource fee and a prepared transaction.
    const simulated = await rpc.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationSuccess(simulated)) {
      throw new Error(
        `fill_intent simulation failed: ${String(
          (simulated as SorobanRpc.Api.SimulateTransactionErrorResponse).error,
        )}`,
      );
    }

    const prepared = SorobanRpc.assembleTransaction(tx, simulated).build();
    prepared.sign(keypair);

    const result = await rpc.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw new Error(
        `fill_intent submission failed: ${result.errorResult?.toXDR("base64") ?? "unknown"}`,
      );
    }

    // Wait for on-chain confirmation before returning the settlement hash.
    for (let attempt = 0; attempt < SOROBAN_MAX_POLL_ATTEMPTS; attempt++) {
      const txStatus = await rpc.getTransaction(result.hash);
      if (txStatus.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return result.hash as Hex;
      }
      if (txStatus.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(
          `fill_intent transaction failed: ${txStatus.resultXdr?.toXDR("base64") ?? "unknown"}`,
        );
      }
      await sleep(SOROBAN_POLL_INTERVAL_MS);
    }

    throw new Error(
      `fill_intent confirmation timeout after ${SOROBAN_MAX_POLL_ATTEMPTS} attempts: ${result.hash}`,
    );
  }

  /**
   * Ask the Soroban settlement contract what fee the outbound
   * FillConfirmed message will cost, so the executor can compute the
   * net settlement proceeds. Returns the fee in stroops (1 XLM = 10^7).
   */
  async quoteFillConfirmedFee(
    settlementContractId: string,
    sorobanSecretKey: string,
    sorobanRpcUrl: string,
  ): Promise<bigint> {
    const keypair = Keypair.fromSecret(sorobanSecretKey);
    const rpc = new SorobanRpc.Server(sorobanRpcUrl);
    const contract = new Contract(settlementContractId);

    const account = await rpc.getAccount(keypair.publicKey());

    // The contract's `quote_fill_confirmed_fee(dst_eid)` helper resolves the
    // LayerZero endpoint and returns the fee for the outbound message. Use a
    // placeholder `dst_eid` of 0 for the quote; the endpoint returns the
    // correct fee based on the actual peer mapping.
    const quoteTx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.stellarNetwork,
    })
      .addOperation(contract.call("quote_fill_confirmed_fee", nativeToScVal(0n, { type: "u32" })))
      .setTimeout(30)
      .build();

    const simulated = await rpc.simulateTransaction(quoteTx);
    if (!SorobanRpc.Api.isSimulationSuccess(simulated) || !simulated.result) {
      throw new Error("FillConfirmed fee quote failed: RPC simulation error");
    }

    const fee = scValToNative(simulated.result.retval);
    if (typeof fee !== "bigint") {
      throw new Error(
        `FillConfirmed fee quote returned unexpected type: ${typeof fee}`,
      );
    }

    if (fee < MIN_FILL_CONFIRMED_LZ_FEE) {
      throw new Error(
        `FillConfirmed fee quote too low: ${fee} stroops (min ${MIN_FILL_CONFIRMED_LZ_FEE})`,
      );
    }

    return fee;
  }

  /**
   * Retrieve the lock record for an intent from the EVM escrow contract.
   *
   * `getLock` is a public mapping getter: it returns a zeroed struct for
   * unknown hashes, so absence is determined from `txHash` rather than from
   * a caught exception. RPC/transport failures propagate to the caller,
   * since they must not be confused with "no lock exists".
   *
   * @param intentHash The hash of the intent.
   * @returns The lock record, or undefined if no lock exists.
   * @throws If the underlying RPC call fails (network, timeout, etc.).
   */
  async getLock(intentHash: Hex): Promise<{ txHash?: string } | undefined> {
    const publicClient = createPublicClient({
      transport: http(this.evmRpcUrl),
    });

    const lock = await publicClient.readContract({
      address: this.escrowAddress,
      abi: [
        {
          type: "function",
          name: "getLock",
          stateMutability: "view",
          inputs: [{ name: "intentHash", type: "bytes32" }],
          outputs: [
            { name: "solver", type: "address" },
            { name: "user", type: "address" },
            { name: "asset", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "deadline", type: "uint256" },
            { name: "released", type: "bool" },
            { name: "refunded", type: "bool" },
            { name: "txHash", type: "bytes32" },
          ],
        },
      ],
      functionName: "getLock",
      args: [intentHash],
    });

    const lockRecord = lock as {
      txHash?: string;
      released?: boolean;
      refunded?: boolean;
    };

    return lockRecord;
  }

  /**
   * Fetch the real settlement transaction hash for an intent from the EVM
   * escrow contract. The contract emits a `Lock` event on the `lock` call
   * that triggered the fill, and that call's transaction hash is the proof
   * the FillConfirmed message was dispatched and the solver was repaid.
   *
   * `getLock` is a public mapping getter: it returns a zeroed struct for
   * unknown hashes, so we read `txHash` and return it only when it is
   * populated.
   */
  async fetchSettlementTxHash(intentHash: Hex): Promise<string> {
    const publicClient = createPublicClient({
      transport: http(this.evmRpcUrl),
    });

    const lock = await publicClient.readContract({
      address: this.escrowAddress,
      abi: [
        {
          type: "function",
          name: "getLock",
          stateMutability: "view",
          inputs: [{ name: "intentHash", type: "bytes32" }],
          outputs: [
            { name: "solver", type: "address" },
            { name: "user", type: "address" },
            { name: "asset", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "deadline", type: "uint256" },
            { name: "released", type: "bool" },
            { name: "refunded", type: "bool" },
            { name: "txHash", type: "bytes32" },
          ],
        },
      ],
      functionName: "getLock",
      args: [intentHash],
    });

    const lockRecord = lock as {
      txHash?: string;
      released?: boolean;
      refunded?: boolean;
    };

    if (typeof lockRecord.txHash !== "string") {
      throw new Error(
        `no settlement transaction hash found for intent ${intentHash}`,
      );
    }

    return lockRecord.txHash;
  }
}

/**
 * Decode a `0x`-prefixed hex string to a `Uint8Array`, refusing non-32-byte
 * hashes for the Soroban contract views.
 */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== 64) {
    throw new Error(`Invalid intent hash length: ${hex}`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Encode a 20-byte EVM address into a 32-byte buffer, left-justified
 * (address in bytes 0–19, zeros in bytes 20–31).
 *
 * The Soroban contract stores `solver_evm` as `BytesN<32>` and decodes the
 * payout address from the first 20 bytes when emitting `FillConfirmed`, so
 * the address is left-justified to match the contract's decoding convention.
 */
function evmAddressTo32Bytes(address: string): Uint8Array {
  const clean = address.startsWith("0x") ? address.slice(2) : address;
  if (clean.length !== 40) {
    throw new Error(`Invalid EVM address length: ${address}`);
  }
  const buf = new Uint8Array(32);
  for (let i = 0; i < 20; i++) {
    buf[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return buf;
}

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
