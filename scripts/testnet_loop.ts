/**
 * Blend Protocol · USDC Leverage Loop · Stellar Testnet
 *
 * Steps:
 *   1. Establish USDC trustline (classic Stellar)
 *   2. Buy USDC on testnet DEX (XLM → USDC)
 *   3. Execute N×[SupplyCollateral, Borrow] via pool.submit() in a single tx
 *
 * Usage:
 *   TESTNET_SECRET=S... npx tsx testnet_loop.ts [--loops N] [--initial USDC] [--dry-run]
 */

import {
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Networks,
  Operation,
  rpc as SorobanRpc,
  TransactionBuilder,
  xdr,
  Address,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";

// ── Constants ────────────────────────────────────────────────────────────────

const POOL_ID   = "CAPBMXIQTICKWFPWFDJWMAKBXBPJZUKLNONQH3MLPLLBKQ643CYN5PRW";
const USDC_ID   = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const XLM_SAC   = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const USDC_ISSUER  = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const RPC_URL      = "https://soroban-testnet.stellar.org";
const HORIZON_URL  = "https://horizon-testnet.stellar.org";
const PASSPHRASE   = Networks.TESTNET;

const SUPPLY_COLLATERAL = 2;
const BORROW            = 4;
const SCALAR            = 10_000_000n; // 1e7

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
const loops       = parseInt(getArg("--loops", "13"));
const initialUsdc = parseFloat(getArg("--initial", "1000"));
const dryRun      = args.includes("--dry-run");

const secret = process.env.TESTNET_SECRET;
if (!secret) { console.error("TESTNET_SECRET env var required"); process.exit(1); }
const keypair = Keypair.fromSecret(secret);
const account = keypair.publicKey();
console.log(`Account: ${account}`);

// ── Clients ──────────────────────────────────────────────────────────────────

const server  = new SorobanRpc.Server(RPC_URL);
const horizon = new Horizon.Server(HORIZON_URL);

// ── Leverage math ─────────────────────────────────────────────────────────────

// Build flat request list: n borrows + (n+1) supplies.
// The final extra supply re-deposits the last borrow proceeds without a
// matching borrow, ensuring HF = (1-c^(n+1)) / (c*(1-c^n)) > 1.0.
// This matches the leverage(n) formula used in simulate.rs.
function buildRequestList(initialStroops: bigint, cFactor: bigint, n: number): xdr.ScVal[] {
  const items: xdr.ScVal[] = [];
  let balance = initialStroops;
  for (let i = 0; i < n; i++) {
    const supply = balance;
    const borrow = supply * cFactor / SCALAR;
    items.push(buildRequest(USDC_ID, supply, SUPPLY_COLLATERAL));
    items.push(buildRequest(USDC_ID, borrow, BORROW));
    balance = borrow;
  }
  // Final supply — no borrow: locks in HF > 1.0
  items.push(buildRequest(USDC_ID, balance, SUPPLY_COLLATERAL));
  return items;
}

// ── Soroban ScVal helpers ─────────────────────────────────────────────────────

function i128ToScVal(n: bigint): xdr.ScVal {
  // i128 stored as high+low 64-bit parts
  const hi = n < 0n ? ~((-n - 1n) >> 64n) & 0xFFFFFFFFFFFFFFFFn
                    : n >> 64n;
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
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("address"),
      val: new Address(assetId).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("amount"),
      val: i128ToScVal(amount),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("request_type"),
      val: nativeToScVal(requestType, { type: "u32" }),
    }),
  ]);
}

function buildRequestsVec(items: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec(items);
}

// ── Classic Stellar: trustline + DEX swap ────────────────────────────────────

async function ensureUsdcBalance(needed: number): Promise<void> {
  const usdcAsset = new Asset("USDC", USDC_ISSUER);

  const acc = await horizon.loadAccount(account);

  // Check existing USDC balance (classic layer)
  const usdcBalance = acc.balances.find(
    (b: any) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER
  );
  const currentUsdc = usdcBalance ? parseFloat(usdcBalance.balance) : 0;

  console.log(`\nClassic USDC balance: ${currentUsdc}`);

  if (currentUsdc >= needed) {
    console.log("✓ Sufficient USDC already in account.");
    return;
  }

  const needed2 = needed - currentUsdc;
  console.log(`Need ${needed2.toFixed(2)} more USDC. Acquiring via testnet DEX…`);

  const txBuilder = new TransactionBuilder(acc, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  }).setTimeout(60);

  // Establish trustline if needed
  if (!usdcBalance) {
    console.log("  → Establishing USDC trustline…");
    txBuilder.addOperation(
      Operation.changeTrust({ asset: usdcAsset, limit: "1000000" })
    );
  }

  // Path payment: XLM → USDC via Stellar DEX
  const xlmToSpend = (needed2 * 12).toFixed(7); // 12× slippage buffer
  console.log(`  → Path payment: up to ${xlmToSpend} XLM → ${needed2.toFixed(2)} USDC`);
  txBuilder.addOperation(
    Operation.pathPaymentStrictReceive({
      sendAsset:    Asset.native(),
      sendMax:      xlmToSpend,
      destination:  account,
      destAsset:    usdcAsset,
      destAmount:   needed2.toFixed(7),
      path:         [],
    })
  );

  const tx = txBuilder.build();
  tx.sign(keypair);

  if (dryRun) {
    console.log("  [DRY-RUN] Would submit classic tx:", tx.hash().toString("hex"));
    return;
  }

  const result = await horizon.submitTransaction(tx);
  if (!result.successful) {
    console.error("Classic tx failed:", JSON.stringify((result as any).extras?.result_codes));
    process.exit(1);
  }
  console.log(`  ✓ USDC acquired. Tx: ${result.hash}`);
}

// ── Soroban tx helper ────────────────────────────────────────────────────────

async function simulateAndSubmit(
  label: string,
  buildOp: (acc: any) => any,
): Promise<string> {
  const acc = await server.getAccount(account);
  const tx = new TransactionBuilder(acc, {
    fee: (BigInt(BASE_FEE) * 10n).toString(),
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(buildOp(acc))
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
    await new Promise(r => setTimeout(r, 3000));
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

// ── Step: approve USDC spending for pool ────────────────────────────────────

async function approveUsdc(amountStroops: bigint, expirationLedger: number): Promise<void> {
  console.log(`\nApproving pool to spend ${Number(amountStroops) / 1e7} USDC (ledger ${expirationLedger})…`);
  const usdc = new Contract(USDC_ID);
  const addrScVal  = new Address(account).toScVal();
  const poolScVal  = new Address(POOL_ID).toScVal();

  await simulateAndSubmit("usdc.approve", () =>
    usdc.call(
      "approve",
      addrScVal,                                    // from
      poolScVal,                                    // spender
      i128ToScVal(amountStroops),                   // amount
      nativeToScVal(expirationLedger, { type: "u32" }), // expiration_ledger
    )
  );
}

// ── Soroban: pool.submit_with_allowance() ─────────────────────────────────────

async function executeLoop(cFactor: bigint): Promise<void> {
  const initialStroops = BigInt(Math.round(initialUsdc * 10_000_000));

  // n borrows + (n+1) supplies — final extra supply ensures HF > 1.0
  const requestItems = buildRequestList(initialStroops, cFactor, loops);
  const nBorrows = loops;
  const nSupplies = loops + 1;

  // Compute totals for display: leverage = (1 - c^(n+1)) / (1 - c)
  const c = Number(cFactor) / 1e7;
  const lev = (1 - Math.pow(c, loops + 1)) / (1 - c);
  const totalSupplyDisplay = initialUsdc * lev;
  const totalBorrowDisplay = totalSupplyDisplay - initialUsdc;
  const hf = (totalSupplyDisplay * c) / totalBorrowDisplay;

  // Net tokens user transfers to pool = initial deposit only
  const netStroops = initialStroops + 1n; // +1 stroop buffer for rounding

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║       Blend Testnet · USDC Leverage Loop Executor        ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`  Loops:    ${loops}  (${nBorrows} borrows + ${nSupplies} supplies = ${requestItems.length} requests)`);
  console.log(`  Initial:  $${initialUsdc.toFixed(2)} USDC`);
  console.log(`  c_factor: ${c * 100}%`);
  console.log(`  Leverage: ${lev.toFixed(3)}×   HF: ${hf.toFixed(4)}`);
  console.log(`  Net pull from wallet: $${initialUsdc.toFixed(2)} USDC (NET settlement via submit_with_allowance)`);
  console.log(`  ${dryRun ? "── DRY RUN ──" : "⚠  TESTNET LIVE MODE"}`);

  // Step 1: approve pool to pull the net USDC amount from our account
  // Get current ledger for expiration (+100 ledgers ≈ 8 min buffer)
  const ledgerResp = await server.getLatestLedger();
  const expiryLedger = ledgerResp.sequence + 100;
  await approveUsdc(netStroops, expiryLedger);

  // Step 2: submit_with_allowance (NET settlement — pool pulls only ~initial from user)
  const pool = new Contract(POOL_ID);
  const addrScVal = new Address(account).toScVal();
  const requests  = buildRequestsVec(requestItems);

  await simulateAndSubmit("pool.submit_with_allowance", () =>
    pool.call("submit_with_allowance", addrScVal, addrScVal, addrScVal, requests)
  );

  console.log(`\nCheck position:`);
  console.log(`  stellar contract invoke --id ${POOL_ID} --network testnet -- get_positions --address ${account}`);
}

// ── Fetch pool c_factor for USDC ─────────────────────────────────────────────

async function fetchCFactor(): Promise<bigint> {
  const pool = new Contract(POOL_ID);
  const acc  = await server.getAccount(account);

  const tx = new TransactionBuilder(acc, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(pool.call("get_reserve", new Address(USDC_ID).toScVal()))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    console.warn("Could not fetch c_factor, defaulting to 9800000");
    return 9_800_000n;
  }

  const raw: any = scValToNative(sim.result!.retval);
  return BigInt(raw.config.c_factor);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cFactor = await fetchCFactor();
  console.log(`Pool c_factor: ${Number(cFactor) / 1e7 * 100}% (live from RPC)`);

  await ensureUsdcBalance(initialUsdc);
  await executeLoop(cFactor);
}

main().catch(e => { console.error(e); process.exit(1); });
