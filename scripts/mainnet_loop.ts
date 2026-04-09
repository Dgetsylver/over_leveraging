/**
 * Blend Protocol · CETES Leverage Loop · Stellar Mainnet
 *
 * Executes N×[SupplyCollateral, Borrow] via pool.submit_with_allowance() in a
 * single Soroban transaction. Only the net seed amount (initial CETES) is
 * pulled from your wallet — borrowed CETES is re-supplied atomically.
 *
 * Two sequential on-chain steps:
 *   1. cetes.approve(pool, initial_amount)   ← sets spending allowance
 *   2. pool.submit_with_allowance(...)        ← executes the leverage loop
 *
 * Usage:
 *   MAINNET_SECRET=S... npx tsx mainnet_loop.ts [--loops N] [--initial CETES] [--dry-run]
 *
 * Key file alternative (recommended for mainnet):
 *   Store your secret key in a file and pipe it:
 *   MAINNET_SECRET=$(cat ~/.keys/mainnet.key) npx tsx mainnet_loop.ts ...
 *
 * Pool:  CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI (Etherfuse)
 * CETES: CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV
 * c_factor: 80% → max theoretical leverage ≈ 5×
 *
 * ⚠  MAINNET — real funds. Always dry-run first.
 * ⚠  With c_factor=0.80, HF drops quickly with more loops:
 *       5 loops → 3.69× leverage, HF ≈ 1.097  (comfortable)
 *       7 loops → 4.02× leverage, HF ≈ 1.053  (moderate)
 *      10 loops → 4.46× leverage, HF ≈ 1.024  (tight)
 *      13 loops → 4.78× leverage, HF ≈ 1.012  (dangerous — near liquidation)
 */

import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

// ── Constants ─────────────────────────────────────────────────────────────────

const POOL_ID   = "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI";
const CETES_ID  = "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV";
const RPC_URL   = "https://mainnet.sorobanrpc.com";
const PASSPHRASE = Networks.PUBLIC;

const SUPPLY_COLLATERAL = 2;
const BORROW            = 4;
const SCALAR            = 10_000_000n; // 1e7

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
const loops       = parseInt(getArg("--loops", "7"));
const initialCetes = parseFloat(getArg("--initial", "1000"));
const dryRun      = args.includes("--dry-run");

if (loops > 10) {
  console.warn(`\n⚠  WARNING: ${loops} loops with c_factor=80% gives HF ≈ ${hfAt(loops).toFixed(4)}`);
  console.warn(`   That is close to the liquidation threshold of 1.0. Consider fewer loops.\n`);
}

const secret = process.env.MAINNET_SECRET;
if (!secret) { console.error("MAINNET_SECRET env var required"); process.exit(1); }
const keypair = Keypair.fromSecret(secret);
const account = keypair.publicKey();
console.log(`Account: ${account}`);

// ── HF helper ─────────────────────────────────────────────────────────────────

function hfAt(n: number, c = 0.8): number {
  return (1 - Math.pow(c, n + 1)) / (1 - Math.pow(c, n));
}

// ── RPC client ────────────────────────────────────────────────────────────────

const server = new SorobanRpc.Server(RPC_URL);

// ── ScVal helpers ─────────────────────────────────────────────────────────────

function i128ToScVal(n: bigint): xdr.ScVal {
  const hi = n < 0n ? ~((-n - 1n) >> 64n) & 0xFFFFFFFFFFFFFFFFn : n >> 64n;
  const lo = n & 0xFFFFFFFFFFFFFFFFn;
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: xdr.Int64.fromString(hi.toString()),
      lo: xdr.Uint64.fromString(lo.toString()),
    })
  );
}

function buildRequest(assetId: string, amount: bigint, requestType: number): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("address"), val: new Address(assetId).toScVal() }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"),  val: i128ToScVal(amount) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("request_type"), val: nativeToScVal(requestType, { type: "u32" }) }),
  ]);
}

// ── Leverage math ─────────────────────────────────────────────────────────────

// n borrows + (n+1) supplies — final extra supply ensures HF > 1.0 strictly.
function buildRequestList(initialStroops: bigint, cFactor: bigint, n: number): xdr.ScVal[] {
  const items: xdr.ScVal[] = [];
  let balance = initialStroops;
  for (let i = 0; i < n; i++) {
    const supply = balance;
    const borrow = supply * cFactor / SCALAR;
    items.push(buildRequest(CETES_ID, supply, SUPPLY_COLLATERAL));
    items.push(buildRequest(CETES_ID, borrow, BORROW));
    balance = borrow;
  }
  // Final supply-only — re-deposits last borrow proceeds, no more borrowing.
  items.push(buildRequest(CETES_ID, balance, SUPPLY_COLLATERAL));
  return items;
}

function buildRequestsVec(items: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec(items);
}

// ── Fetch pool c_factor for CETES ─────────────────────────────────────────────

async function fetchCFactor(): Promise<bigint> {
  const pool = new Contract(POOL_ID);
  const acc  = await server.getAccount(account);
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(pool.call("get_reserve", new Address(CETES_ID).toScVal()))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    console.warn("Could not fetch c_factor, defaulting to 8000000");
    return 8_000_000n;
  }
  const raw: any = scValToNative(sim.result!.retval);
  return BigInt(raw.config.c_factor);
}

// ── Submit + poll helper ──────────────────────────────────────────────────────

async function simulateAndSubmit(
  label: string,
  buildOp: () => any,
): Promise<string> {
  const acc = await server.getAccount(account);
  const tx = new TransactionBuilder(acc, {
    fee: (BigInt(BASE_FEE) * 10n).toString(),
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(buildOp())
    .setTimeout(60)
    .build();

  console.log(`\nSimulating ${label}…`);
  const simResult = await server.simulateTransaction(tx);

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    console.error(`Simulation failed (${label}):`, simResult.error);
    process.exit(1);
  }
  if (!SorobanRpc.Api.isSimulationSuccess(simResult)) {
    console.error(`Simulation unexpected result (${label}):`, simResult);
    process.exit(1);
  }

  console.log(`  Min resource fee: ${simResult.minResourceFee} stroops`);
  if (simResult.result?.retval) {
    console.log(`  Return value: ${JSON.stringify(scValToNative(simResult.result.retval), (_k, v) => typeof v === "bigint" ? v.toString() : v)}`);
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would submit ${label}.`);
    return "(dry-run)";
  }

  const assembled = SorobanRpc.assembleTransaction(tx, simResult).build();
  assembled.sign(keypair);

  console.log(`  Submitting ${label}…`);
  const sendResult = await server.sendTransaction(assembled);

  if (sendResult.status === "ERROR") {
    console.error(`sendTransaction error (${label}):`, sendResult.errorResult?.toXDR("base64"));
    process.exit(1);
  }

  let status = sendResult.status;
  while (status === "PENDING" || status === "NOT_FOUND") {
    await new Promise(r => setTimeout(r, 4000));
    const poll = await server.getTransaction(sendResult.hash);
    status = poll.status as any;
    process.stdout.write(`  status: ${status}\r`);
    if (poll.status === "SUCCESS") {
      console.log(`\n  ✓ ${label} confirmed! Hash: ${sendResult.hash}`);
      return sendResult.hash;
    }
    if (poll.status === "FAILED") {
      console.error(`\n  ✗ ${label} failed. Result XDR:`);
      console.error(poll.resultXdr?.toXDR("base64"));
      process.exit(1);
    }
  }
  return sendResult.hash;
}

// ── Check CETES balance ───────────────────────────────────────────────────────

async function checkCetesBalance(): Promise<bigint> {
  const cetes = new Contract(CETES_ID);
  const acc   = await server.getAccount(account);
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(cetes.call("balance", new Address(account).toScVal()))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) return 0n;
  const raw = scValToNative(sim.result!.retval);
  return typeof raw === "bigint" ? raw : BigInt(raw);
}

// ── Step: approve CETES spending ─────────────────────────────────────────────

async function approveCetes(amountStroops: bigint, expirationLedger: number): Promise<void> {
  console.log(`\nApproving pool to spend ${Number(amountStroops) / 1e7} CETES (ledger ${expirationLedger})…`);
  const cetes      = new Contract(CETES_ID);
  const addrScVal  = new Address(account).toScVal();
  const poolScVal  = new Address(POOL_ID).toScVal();

  await simulateAndSubmit("cetes.approve", () =>
    cetes.call(
      "approve",
      addrScVal,
      poolScVal,
      i128ToScVal(amountStroops),
      nativeToScVal(expirationLedger, { type: "u32" }),
    )
  );
}

// ── Main leverage loop ────────────────────────────────────────────────────────

async function executeLoop(cFactor: bigint): Promise<void> {
  const initialStroops = BigInt(Math.round(initialCetes * 10_000_000));
  const requestItems   = buildRequestList(initialStroops, cFactor, loops);
  const nBorrows  = loops;
  const nSupplies = loops + 1;

  const c   = Number(cFactor) / 1e7;
  const lev = (1 - Math.pow(c, loops + 1)) / (1 - c);
  const hf  = hfAt(loops, c);
  const totalSupplyDisplay = initialCetes * lev;
  const totalBorrowDisplay = totalSupplyDisplay - initialCetes;

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║       Blend Mainnet · CETES Leverage Loop Executor       ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`  Pool:     ${POOL_ID}`);
  console.log(`  Asset:    CETES (${CETES_ID})`);
  console.log(`  Loops:    ${loops}  (${nBorrows} borrows + ${nSupplies} supplies = ${requestItems.length} requests)`);
  console.log(`  Initial:  ${initialCetes.toFixed(7)} CETES`);
  console.log(`  c_factor: ${c * 100}%`);
  console.log(`  Leverage: ${lev.toFixed(3)}×   HF: ${hf.toFixed(4)}`);
  console.log(`  Total supply: ${totalSupplyDisplay.toFixed(2)} CETES`);
  console.log(`  Total borrow: ${totalBorrowDisplay.toFixed(2)} CETES`);
  console.log(`  Net pull from wallet: ${initialCetes.toFixed(7)} CETES  (NET settlement)`);
  console.log(`  ${dryRun ? "── DRY RUN (--dry-run) ──" : "⚠  LIVE MODE — STELLAR MAINNET — REAL FUNDS"}`);

  if (hf < 1.03 && !dryRun) {
    console.error(`\n  ✗ Refusing to submit: HF=${hf.toFixed(4)} is below safety threshold (1.03).`);
    console.error(`    Use fewer loops or pass --dry-run to inspect.`);
    process.exit(1);
  }

  // Step 1: approve
  const ledgerResp    = await server.getLatestLedger();
  const expiryLedger  = ledgerResp.sequence + 100; // ~8 min buffer
  await approveCetes(initialStroops + 1n, expiryLedger);

  // Step 2: submit_with_allowance (NET settlement)
  const pool      = new Contract(POOL_ID);
  const addrScVal = new Address(account).toScVal();
  const requests  = buildRequestsVec(requestItems);

  await simulateAndSubmit("pool.submit_with_allowance", () =>
    pool.call("submit_with_allowance", addrScVal, addrScVal, addrScVal, requests)
  );

  console.log(`\nCheck position:`);
  console.log(`  stellar contract invoke --id ${POOL_ID} --network mainnet -- get_positions --address ${account}`);
  console.log(`  https://mainnet.blend.capital/dashboard/?poolId=${POOL_ID}`);
}

// ── HF Monitor with auto-deleverage ─────────────────────────────────────────
//
// When --monitor is passed, instead of opening a new position, the script
// watches the user's existing position and automatically deleverages (repays
// debt by withdrawing collateral) if HF drops below a threshold.
//
// This mitigates the "circular collateral / liquidity lock" vulnerability:
// if utilization is high and HF is dropping, we proactively unwind rather
// than waiting for external liquidators (who may not act because d-tokens
// are illiquid at high utilization).
//
// Usage:
//   MAINNET_SECRET=S... npx tsx mainnet_loop.ts --monitor [--hf-threshold 1.05] [--check-interval 60]

const monitorMode = args.includes("--monitor");
const hfThreshold = parseFloat(getArg("--hf-threshold", "1.05"));
const checkInterval = parseInt(getArg("--check-interval", "60")); // seconds

/** Maximum pool utilization at which new positions are allowed. */
const MAX_SAFE_UTILIZATION = 0.85;

/** Fetch raw reserve data for CETES. */
async function fetchReserve(): Promise<any> {
  const pool = new Contract(POOL_ID);
  const acc  = await server.getAccount(account);
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(pool.call("get_reserve", new Address(CETES_ID).toScVal()))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) return null;
  return scValToNative(sim.result!.retval);
}

/** Fetch user's current position for CETES. */
async function fetchPosition(): Promise<{ collateral: number; debt: number; hf: number } | null> {
  const pool = new Contract(POOL_ID);
  const acc  = await server.getAccount(account);
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(pool.call("get_positions", new Address(account).toScVal()))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) return null;
  const raw: any = scValToNative(sim.result!.retval);

  const reserve = await fetchReserve();
  if (!reserve) return null;

  // CETES is index 2 in the Etherfuse pool reserve list
  const bTokens = BigInt(raw?.collateral?.[2] ?? 0);
  const dTokens = BigInt(raw?.liabilities?.[2] ?? 0);
  if (bTokens === 0n && dTokens === 0n) return null;

  const bRate = BigInt(reserve.data.b_rate);
  const dRate = BigInt(reserve.data.d_rate);
  const RATE_DEC = 1_000_000_000_000n;

  const collateral = Number(bTokens * bRate / RATE_DEC) / 1e7;
  const debt       = Number(dTokens * dRate / RATE_DEC) / 1e7;
  const c          = Number(BigInt(reserve.config.c_factor)) / 1e7;
  const hf         = debt > 0 ? (collateral * c) / debt : Infinity;

  return { collateral, debt, hf };
}

/** Fetch pool utilization for CETES. */
async function fetchUtilization(): Promise<number> {
  const reserve = await fetchReserve();
  if (!reserve) return 0;
  const bRate = Number(BigInt(reserve.data.b_rate)) / 1e12;
  const dRate = Number(BigInt(reserve.data.d_rate)) / 1e12;
  const bSupply = Number(BigInt(reserve.data.b_supply));
  const dSupply = Number(BigInt(reserve.data.d_supply));
  const totalSupply = dSupply * dRate;
  const totalBorrow = bSupply * bRate;
  return totalSupply > 0 ? totalBorrow / totalSupply : 0;
}

/** Execute a partial deleverage: withdraw some collateral and repay equivalent debt. */
async function deleverage(fraction: number): Promise<void> {
  const pos = await fetchPosition();
  if (!pos || pos.debt <= 0) {
    console.log("  No debt to deleverage.");
    return;
  }

  // Deleverage a fraction of the debt
  const repayAmount = BigInt(Math.round(pos.debt * fraction * 1e7));
  const repayWithBuffer = repayAmount * 1005n / 1000n; // +0.5% buffer

  const pool      = new Contract(POOL_ID);
  const addrScVal = new Address(account).toScVal();
  const requests  = xdr.ScVal.scvVec([
    buildRequest(CETES_ID, repayWithBuffer, 3), // WITHDRAW_COLLATERAL
    buildRequest(CETES_ID, repayWithBuffer, 5), // REPAY
  ]);

  await simulateAndSubmit("deleverage (withdraw+repay)", () =>
    pool.call("submit_with_allowance", addrScVal, addrScVal, addrScVal, requests)
  );
}

async function monitorLoop(): Promise<void> {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║       Blend Mainnet · HF Monitor & Auto-Deleverage       ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`  Account:        ${account}`);
  console.log(`  HF threshold:   ${hfThreshold}`);
  console.log(`  Check interval: ${checkInterval}s`);
  console.log(`  Dry run:        ${dryRun}`);
  console.log(`\nMonitoring… (Ctrl+C to stop)\n`);

  while (true) {
    try {
      const pos = await fetchPosition();
      const util = await fetchUtilization();
      const now = new Date().toISOString().slice(11, 19);

      if (!pos) {
        console.log(`  [${now}] No active position found.`);
      } else {
        const status = pos.hf < hfThreshold ? "⚠ DANGER" :
                       pos.hf < hfThreshold * 1.1 ? "⚡ WATCH" : "✓ OK";
        console.log(
          `  [${now}] HF=${pos.hf.toFixed(4)} ` +
          `coll=${pos.collateral.toFixed(2)} debt=${pos.debt.toFixed(2)} ` +
          `util=${(util * 100).toFixed(1)}% ${status}`
        );

        // Auto-deleverage if HF is below threshold
        if (pos.hf < hfThreshold && pos.debt > 0) {
          console.log(`\n  ⚠ HF ${pos.hf.toFixed(4)} < ${hfThreshold} — triggering auto-deleverage!`);

          if (dryRun) {
            console.log(`  [DRY RUN] Would deleverage 25% of debt (${(pos.debt * 0.25).toFixed(2)} CETES)`);
          } else {
            // Deleverage 25% of debt each time — brings HF back up without
            // fully closing the position (preserving BLND emission exposure).
            await deleverage(0.25);
            console.log(`  Auto-deleverage complete. Rechecking position…\n`);
            continue; // Re-check immediately
          }
        }

        // Warn about high utilization even if HF is OK
        if (util > MAX_SAFE_UTILIZATION) {
          console.log(
            `  ⚠ Pool utilization ${(util * 100).toFixed(1)}% > ${(MAX_SAFE_UTILIZATION * 100).toFixed(0)}% — ` +
            `d-tokens illiquid, liquidators may not act. Consider manual deleverage.`
          );
        }
      }
    } catch (e: any) {
      console.error(`  [error] ${e?.message ?? e}`);
    }

    await new Promise(r => setTimeout(r, checkInterval * 1000));
  }
}

// ── Pre-flight safety checks for opening new positions ────────────────────────

async function checkSafety(cFactor: bigint): Promise<void> {
  const util = await fetchUtilization();
  const c = Number(cFactor) / 1e7;

  console.log(`\n  Pool utilization: ${(util * 100).toFixed(1)}%`);

  if (util > MAX_SAFE_UTILIZATION) {
    console.error(
      `\n  ✗ Pool utilization ${(util * 100).toFixed(1)}% exceeds ${(MAX_SAFE_UTILIZATION * 100).toFixed(0)}% safety cap.`
    );
    console.error(
      `    High utilization means collateral d-tokens are illiquid — liquidators won't act.`
    );
    if (!dryRun) process.exit(1);
    console.error(`    (Continuing in dry-run mode despite safety failure)`);
  }

  // Projected utilization after loop
  const reserve = await fetchReserve();
  if (reserve) {
    const bRate = Number(BigInt(reserve.data.b_rate)) / 1e12;
    const dRate = Number(BigInt(reserve.data.d_rate)) / 1e12;
    const bSupply = Number(BigInt(reserve.data.b_supply));
    const dSupply = Number(BigInt(reserve.data.d_supply));
    const poolSupply = dSupply * dRate / 1e7;
    const poolBorrow = bSupply * bRate / 1e7;

    const lev = (1 - Math.pow(c, loops + 1)) / (1 - c);
    const addSupply = initialCetes * lev;
    const addBorrow = initialCetes * (lev - 1);
    const projUtil = (poolBorrow + addBorrow) / (poolSupply + addSupply);

    if (projUtil > MAX_SAFE_UTILIZATION) {
      console.error(
        `\n  ✗ This position would push utilization to ${(projUtil * 100).toFixed(1)}%. ` +
        `Reduce --loops or --initial.`
      );
      if (!dryRun) process.exit(1);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (monitorMode) {
    await monitorLoop();
    return;
  }

  const cFactor = await fetchCFactor();
  console.log(`\nPool CETES c_factor: ${Number(cFactor) / 1e7 * 100}% (live from RPC)`);

  const balanceStroops = await checkCetesBalance();
  const balanceCetes   = Number(balanceStroops) / 1e7;
  console.log(`CETES balance: ${balanceCetes.toFixed(7)}`);

  if (balanceCetes < initialCetes && !dryRun) {
    console.error(`\n  ✗ Insufficient CETES: have ${balanceCetes.toFixed(7)}, need ${initialCetes.toFixed(7)}`);
    process.exit(1);
  }

  // Safety checks before opening position
  await checkSafety(cFactor);

  await executeLoop(cFactor);
}

main().catch(e => { console.error(e); process.exit(1); });
