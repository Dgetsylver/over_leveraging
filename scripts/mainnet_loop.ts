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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cFactor = await fetchCFactor();
  console.log(`\nPool CETES c_factor: ${Number(cFactor) / 1e7 * 100}% (live from RPC)`);

  const balanceStroops = await checkCetesBalance();
  const balanceCetes   = Number(balanceStroops) / 1e7;
  console.log(`CETES balance: ${balanceCetes.toFixed(7)}`);

  if (balanceCetes < initialCetes && !dryRun) {
    console.error(`\n  ✗ Insufficient CETES: have ${balanceCetes.toFixed(7)}, need ${initialCetes.toFixed(7)}`);
    process.exit(1);
  }

  await executeLoop(cFactor);
}

main().catch(e => { console.error(e); process.exit(1); });
