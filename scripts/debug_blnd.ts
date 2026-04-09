import { Account, Address, BASE_FEE, Contract, Networks, rpc as SorobanRpc, scValToNative, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

const ORACLE_ID = "CAVRP26CWW6IUEXBRA3Q2T2SHBUVBC2DF43M4E23LEZGW5ZEIB62HALS";
const BLND_ID   = "CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY";
const NULL_ACC  = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ORACLE_DEC = 1e14;
const SCALAR_F   = 1e7;
const SECONDS_PER_YEAR = 31_536_000;
const server = new SorobanRpc.Server("https://rpc.lightsail.network/");

function assetScVal(id: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Stellar"), new Address(id).toScVal()]);
}
async function sim(op: xdr.Operation): Promise<any> {
  const acc = new Account(NULL_ACC, "0");
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: Networks.PUBLIC })
    .addOperation(op).setTimeout(30).build();
  const r = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(r)) { console.log("sim failed:", (r as any).error?.slice(0,200)); return null; }
  return scValToNative(r.result!.retval);
}

async function main() {
  const oracle = new Contract(ORACLE_ID);
  const pool   = new Contract("CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI");

  // 1. Oracle price for BLND
  console.log("=== Oracle BLND price ===");
  const raw = await sim(oracle.call("lastprice", assetScVal(BLND_ID)));
  console.log("raw:", JSON.stringify(raw, (_,v) => typeof v==="bigint"?v.toString():v));
  if (raw) console.log("BLND price USD:", Number(BigInt(raw.price)) / ORACLE_DEC);

  // 2. USDC supply emissions
  console.log("\n=== USDC supply emissions (token id=3) ===");
  const emissions = await sim(pool.call("get_reserve_emissions", { type: "u32", value: 3 }));
  console.log("emissions:", JSON.stringify(emissions, (_,v) => typeof v==="bigint"?v.toString():v));
  if (emissions?.eps != null) {
    const eps = Number(BigInt(emissions.eps));
    const blndPerYr = eps * SECONDS_PER_YEAR / SCALAR_F / SCALAR_F;
    console.log("BLND/yr:", blndPerYr);
    // What blnd price gives 4.68% APR on $115K USDC supply?
    const targetApr = 0.0468;
    const supplyUsd = 115327;
    const impliedPrice = (targetApr * supplyUsd) / blndPerYr;
    console.log("Implied BLND price for 4.68% APR:", impliedPrice);
  }

  // 3. CoinGecko
  console.log("\n=== CoinGecko blend-2 ===");
  const r1 = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=blend-2&vs_currencies=usd");
  console.log(await r1.json());
}

main().catch(console.error);
