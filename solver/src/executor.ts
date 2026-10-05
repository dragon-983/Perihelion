// SPDX-License-Identifier: MIT

/**
 * Executor: orchestrates the two settlement legs of a fill.
 *
 * 1. Calls EVM escrow `lock` to lock source funds
 * 2. Calls Soroban `fill_intent` to deliver destination assets
 * 3. Tracks settlement status and handles idempotent retries
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
} from "viem";
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
import { ESCROW_ABI } from "@perihelion/sdk";
import type { SignedIntent } from "@perihelion/sdk";
import { PerihelionEscrowClient } from "@perihelion/sdk";
import type { Metrics } from "./metrics.js";

/**
 * Thrown (or re-thrown) by an executor when a fill has *definitively* failed —
 * i.e. the on-chain transaction was rejected or reverted — and the capital was
 * never committed.  The solver catches this specifically in {@link Solver.consider}
 * and immediately releases the in-flight reservation.
 *
 * Contrast with a generic `Error` or a timeout, where the transaction may have
 * already landed (or may still land), so the reservation must be held until the
 * next inventory refresh to avoid double-spending.
 *
 * ## Usage
 *
 * ```ts
 * throw new DefiniteFailureError("escrow lock reverted: InsufficientBalance");
 * // or wrap an underlying cause:
 * throw new DefiniteFailureError("lock reverted", { cause: revertError });
 * ```
 */
export class DefiniteFailureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DefiniteFailureError";
  }
}

/** Logger interface for structured logging. */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Configuration for executor (keys and RPC endpoints). */
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

/** Idempotency check result. */
interface FillStatus {
  filled: boolean;
  settlementTx?: string;
}

/**
 * How many times to poll for a Soroban transaction confirmation before
 * giving up. Each attempt sleeps SOROBAN_POLL_INTERVAL_MS.
 */
const SOROBAN_MAX_POLL_ATTEMPTS = 30;
const SOROBAN_POLL_INTERVAL_MS = 2_000;

/**
 * Execute a fill by orchestrating EVM lock and Soroban fill_intent.
 *
 * Handles idempotent retries: before re-filling, queries current status
 * to avoid double-fills.
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
  private readonly metrics?: Metrics;

  constructor(config?: ExecutorConfig, logger: Logger = console, metrics?: Metrics) {
    this.evmRpcUrl = config?.evmRpcUrl ?? "";
    this.sorobanRpcUrl = config?.sorobanRpcUrl ?? "";
    this.evmPrivateKey = config?.evmPrivateKey ?? ("0x" as Hex);
    this.sorobanSecretKey = config?.sorobanSecretKey ?? "";
    this.escrowAddress = config?.escrowAddress ?? ("0x" as `0x${string}`);
    this.settlementContractId = config?.settlementContractId ?? "";
    this.sourceChainId = config?.sourceChainId ?? 0;
    this.stellarNetwork = config?.stellarNetwork ?? "";
    this.logger = logger;
    this.metrics = metrics;
  }

  /**
   * Fill an intent: lock source funds and deliver destination assets.
   * Idempotent: checks fill status before attempting retry.
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

    // Check if already filled (idempotency)
    const status = await this.checkFillStatus(hash);
    if (status.filled && status.settlementTx) {
      this.logger.info("intent already settled, skipping", { hash });
      return { settlementTx: status.settlementTx };
    }

    // Step 1: Lock on EVM escrow
    const lockTx = await this.lockOnEvm(signed);
    this.logger.info("locked on EVM", { hash, lockTx });

    // Step 2: Fill on Soroban (deliver dest asset, dispatch FillConfirmed)
    const fillResult = await this.fillOnSoroban(signed, lockTx);
    const settlementTx = typeof fillResult === "string" ? fillResult : (fillResult as { txHash: string }).txHash;
    const stellarFeeStroops = typeof fillResult === "object" && "feeStroops" in (fillResult as any) ? (fillResult as any).feeStroops : 10000n;
    this.logger.info("filled on Soroban", { hash, settlementTx });

    // gas wei: since lockOnEvm no longer waits for the receipt, we estimate 0 here.
    // The solver can compute the actual gas from the receipt if needed.
    const sourceGasWei = 0n;
    // lzFeeWei is no longer returned from lockOnEvm; use 0 for now — the solver
    // records fees from the settlement result separately.
    const lzFeeWei = 0n;
    const fees = {
        sourceGasWei,
        lzFeeWei,
        stellarFeeStroops,
      };
    if (this.metrics) {
      this.metrics.recordFee(sourceGasWei);
    }
    return {
      settlementTx,
      fees,
    };
  }

  /**
   * Check if an intent has already been filled (idempotency check).
   * Queries the settlement contract status to see if status() returns
   * 'Settled' or 'ConfirmationSent'.
   */
  private async checkFillStatus(intentHash: Hex): Promise<FillStatus> {
    try {
      const result = await this.isSettled(intentHash);
      // Handle both the new { settled, settlementTx } shape and the
      // test override that returns a bare boolean.
      const settled =
        typeof result === "boolean"
          ? result
          : result?.settled;
      if (settled) {
        const settlementTx =
          typeof result === "boolean"
            ? intentHash
            : result?.settlementTx ?? intentHash;
        return { filled: true, settlementTx };
      }
    } catch {
      // Query failure is not fatal; proceed with fill attempt.
      // Do NOT treat query errors as "not settled" — the fill may still
      // succeed and the status may be available on the next attempt.
    }
    return { filled: false };
  }

  /**
   * Check if an intent is settled on the Soroban settlement contract.
   *
   * Calls the settlement contract's `status(intentHash)` view function and
   * decodes the return value to determine if the intent has been filled or
   * had its confirmation dispatched.  Returns the real settlement tx hash
   * when the intent is settled.
   */
  private async isSettled(intentHash: Hex): Promise<{ settled: boolean; settlementTx: string }> {
    const rpc = new SorobanRpc.Server(this.sorobanRpcUrl);
    const keypair = Keypair.fromSecret(this.sorobanSecretKey);
    const account = await rpc.getAccount(keypair.publicKey());

    const contract = new Contract(this.settlementContractId);

    // intentHash is 0x-prefixed 32-byte hex; decode to raw bytes for the
    // Soroban bytes32 argument.
    const hashBytes = hexToBytes(intentHash);

    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.stellarNetwork,
    })
      .addOperation(
        contract.call("status", xdr.ScVal.scvBytes(Buffer.from(hashBytes))),
      )
      .setTimeout(30)
      .build();

    const simulated = await rpc.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationSuccess(simulated) || !simulated.result) {
      return { settled: false, settlementTx: intentHash };
    }

    // The status enum decodes to a bare symbol string (e.g. "Settled") or a
    // [tag, ...payload] array — same pattern as soroban-delivery.ts readStatus.
    const native: unknown = scValToNative(simulated.result.retval);
    const variant =
      typeof native === "string"
        ? native
        : Array.isArray(native) && typeof native[0] === "string"
          ? native[0]
          : null;

    let settled = false;
    let settlementTx = intentHash;

    if (variant === "Settled" || variant === "ConfirmationSent") {
      settled = true;
      // Try to read the intent record from the contract to get the real
      // settlement transaction hash stored in the memo record.
      try {
        const recordTx = await rpc.getTransaction(intentHash);
        if (
          recordTx.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS &&
          "hash" in recordTx
        ) {
          const rawHash = (recordTx as { hash: string }).hash;
          settlementTx = rawHash.startsWith("0x")
            ? (rawHash as `0x${string}`)
            : ("0x" + rawHash) as `0x${string}`;
        }
      } catch {
        // If we can't fetch the tx, keep the intent hash as marker.
      }
    }

    return { settled, settlementTx };
  }

  /**
   * Lock funds in the EVM escrow contract using the SDK's
   * PerihelionEscrowClient.
   *
   * 1. Quotes the native fee for locking the intent.
   * 2. Calls escrow.lock() and returns the tx hash.
   */
  private async lockOnEvm(signed: SignedIntent): Promise<Hex> {
    const { intent, signature } = signed;

    const account = privateKeyToAccount(this.evmPrivateKey);

    const publicClient = createPublicClient({
      transport: http(this.evmRpcUrl),
    });

    const walletClient = createWalletClient({
      account,
      transport: http(this.evmRpcUrl),
    });

    const escrowClient = new PerihelionEscrowClient(
      publicClient,
      walletClient,
      this.escrowAddress,
    );

    // Convert the SDK intent to the contract tuple format expected by the ABI.
    const contractIntent = {
      user: intent.user,
      destination: intent.destination,
      sourceChainId: Number(intent.sourceChainId),
      sourceAsset: intent.sourceAsset,
      sourceAmount: intent.sourceAmount,
      destAsset: intent.destAsset,
      minDestAmount: intent.minDestAmount,
      deadline: intent.deadline,
      nonce: intent.nonce,
      preferredSolver: intent.preferredSolver,
    };

    // Quote the LayerZero fee via the SDK client.
    const nativeFee = await escrowClient.quoteFee(contractIntent, account.address);

    // Lock the intent via the SDK client.
    const txHash = await escrowClient.lock(contractIntent, signature, nativeFee);

    return txHash;
  }

  /**
   * Fill the intent on Soroban: deliver destination assets and dispatch
   * FillConfirmed back to the source chain over LayerZero.
   *
   * Calls `deliver_intent` to deliver the destination asset and mark the
   * intent Filled, then calls `dispatch_confirmation` to dispatch the
   * FillConfirmed message with the quoted LZ fee.
   *
   * Calls `deliver_intent(solver, solver_evm, intent_hash, fill_amount)`:
   *   - solver:       this solver's Stellar address (derived from the secret key)
   *   - solver_evm:   this solver's EVM address padded to 32 bytes, for the
   *                   FillConfirmed payout destination on the source chain
   *   - intent_hash:  32-byte raw bytes derived from the 0x-prefixed intentHash
   *   - fill_amount:  intent.minDestAmount (i128)
   *
   * Then calls `dispatch_confirmation(caller, intent_hash, lz_fee)`:
   *   - caller:       the solver's Stellar address (authorizing the dispatch)
   *   - intent_hash:  the intent hash
   *   - lz_fee:       quoted LayerZero fee in stroops
   */
  private async fillOnSoroban(signed: SignedIntent, _lockTx: Hex): Promise<Hex> {
    const { intent, hash: intentHash } = signed;

    const keypair = Keypair.fromSecret(this.sorobanSecretKey);
    const rpc = new SorobanRpc.Server(this.sorobanRpcUrl);
    const account = await rpc.getAccount(keypair.publicKey());

    const contract = new Contract(this.settlementContractId);

    // intent_hash: 0x-prefixed 32-byte hex → raw bytes → Soroban BytesN<32>
    const hashBytes = hexToBytes(intentHash);

    // solver_evm: derive from the EVM private key, pad 20-byte address to 32
    // bytes (right-padded with zeros as BytesN<32>; the contract stores the
    // address in the leftmost 20 bytes).
    const solverEvm = privateKeyToAccount(this.evmPrivateKey).address;
    const solverEvmBytes = evmAddressTo32Bytes(solverEvm);

    // solver Stellar address (authorizing the call)
    const solverStellar = nativeToScVal(keypair.publicKey(), { type: "address" });

    // fill_amount = minDestAmount as i128
    const fillAmount = BigInt(intent.minDestAmount);

    const deliverArgs = [
      solverStellar,
      xdr.ScVal.scvBytes(Buffer.from(solverEvmBytes)), // solver: BytesN<32>
      xdr.ScVal.scvBytes(Buffer.from(hashBytes)),        // intent_hash: BytesN<32>
      nativeToScVal(fillAmount, { type: "i128" }),      // fill_amount: i128
    ];

    const lzFeeArgs = [
      solverStellar,
      xdr.ScVal.scvBytes(Buffer.from(solverEvmBytes)), // caller: BytesN<32>
      xdr.ScVal.scvBytes(Buffer.from(hashBytes)),        // intent_hash: BytesN<32>
      nativeToScVal(0n, { type: "i128" }),              // lz_fee: i128 (0 for mock)
    ];

    // Step 1: Call deliver_intent to deliver destination assets and mark Filled.
    const deliverTx = new TransactionBuilder(account, {
      fee: "10000",
      networkPassphrase: this.stellarNetwork,
    })
      .addOperation(contract.call("deliver_intent", ...deliverArgs))
      .setTimeout(60)
      .build();

    // Simulate deliver_intent.
    const simulatedDeliver = await rpc.simulateTransaction(deliverTx);
    if (!SorobanRpc.Api.isSimulationSuccess(simulatedDeliver)) {
      throw new Error(
        `deliver_intent simulation failed: ${String(
          (simulatedDeliver as any).error ?? "unknown",
        )}`,
      );
    }

    const preparedDeliver = SorobanRpc.assembleTransaction(deliverTx, simulatedDeliver)
      .build();
    preparedDeliver.sign(keypair);

    const deliverResult = await rpc.sendTransaction(preparedDeliver);
    if (deliverResult.status === "ERROR") {
      throw new Error(
        `deliver_intent submission failed: ${deliverResult.errorResult?.toXDR("base64") ?? "unknown"}`,
      );
    }

    // Poll until the deliver_intent transaction is confirmed.
    for (let attempt = 0; attempt < SOROBAN_MAX_POLL_ATTEMPTS; attempt++) {
      const txStatus = await rpc.getTransaction(deliverResult.hash);
      if (txStatus.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        break;
      }
      if (txStatus.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(
          `deliver_intent transaction failed: ${txStatus.resultXdr?.toXDR("base64") ?? "unknown"}`,
        );
      }
      await sleep(SOROBAN_POLL_INTERVAL_MS);
    }

    // Step 2: Call dispatch_confirmation to dispatch FillConfirmed with LZ fee.
    const preparedConfirm = new TransactionBuilder(account, {
      fee: "10000",
      networkPassphrase: this.stellarNetwork,
    })
      .addOperation(contract.call("dispatch_confirmation", ...lzFeeArgs))
      .setTimeout(60)
      .build();

    // Simulate dispatch_confirmation.
    const simulatedConfirm = await rpc.simulateTransaction(preparedConfirm);
    if (!SorobanRpc.Api.isSimulationSuccess(simulatedConfirm)) {
      throw new Error(
        `dispatch_confirmation simulation failed: ${String(
          (simulatedConfirm as any).error ?? "unknown",
        )}`,
      );
    }

    const preparedConfirmBuilt = SorobanRpc.assembleTransaction(
      preparedConfirm,
      simulatedConfirm,
    ).build();
    preparedConfirmBuilt.sign(keypair);

    const confirmResult = await rpc.sendTransaction(preparedConfirmBuilt);
    if (confirmResult.status === "ERROR") {
      throw new Error(
        `dispatch_confirmation submission failed: ${confirmResult.errorResult?.toXDR("base64") ?? "unknown"}`,
      );
    }

    // Poll until the dispatch_confirmation transaction is confirmed.
    for (let attempt = 0; attempt < SOROBAN_MAX_POLL_ATTEMPTS; attempt++) {
      const txStatus = await rpc.getTransaction(confirmResult.hash);
      if (txStatus.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return confirmResult.hash as Hex;
      }
      if (txStatus.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(
          `dispatch_confirmation transaction failed: ${txStatus.resultXdr?.toXDR("base64") ?? "unknown"}`,
        );
      }
      await sleep(SOROBAN_POLL_INTERVAL_MS);
    }

    throw new Error(
      `dispatch_confirmation confirmation timeout after ${SOROBAN_MAX_POLL_ATTEMPTS} attempts: ${confirmResult.hash}`,
    );
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decode a 0x-prefixed hex string to a Uint8Array.
 * Strips the "0x" prefix before parsing.
 */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`Invalid hex length: ${hex}`);
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Encode a 20-byte EVM address into a 32-byte buffer, left-justified
 * (address in bytes 0–19, zeros in bytes 20–31).
 *
 * The Soroban contract stores `solver_evm` as `BytesN<32>` and decodes
 * the payout address from the first 20 bytes when emitting FillConfirmed.
 */
function evmAddressTo32Bytes(address: string): Uint8Array {
  const clean = address.startsWith("0x") ? address.slice(2) : address;
  if (clean.length !== 40) throw new Error(`Invalid EVM address length: ${address}`);
  const buf = new Uint8Array(32);
  for (let i = 0; i < 20; i++) {
    buf[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return buf;
}
