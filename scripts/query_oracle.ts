/**
 * Query the Etherfuse oracle contract directly to understand its type and behavior.
 * Tests: admin, config, lastprice, decimals, and whether it's a Reflector instance or adaptor.
 */
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

const ORACLE_ID = "CAVRP26CWW6IUEXBRA3Q2T2SHBUVBC2DF43M4E23LEZGW5ZEIB62HALS";
const RPC_URL   = "https://rpc.lightsail.network/";
const NETWORK   = Networks.PUBLIC;
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const server = new SorobanRpc.Server(RPC_URL);

const ASSETS = {
  TESOURO: "CD6M4R2322BYCY2LNWM74PEBQAQ63SA3DUJLI3L4225U4ZVCLMSCBCIS",
  USTRY:   "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR",
  CETES:   "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV",
  USDC:    "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  XLM:     "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
};

function assetScVal(contractId: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Stellar"),
    new Address(contractId).toScVal(),
  ]);
}

async function sim(op: xdr.Operation): Promise<any> {
  const acc = new Account(NULL_ACCOUNT, "0");
  const tx  = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(op).setTimeout(30).build();
  const result = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(result)) {
    return { error: (result as any).error };
  }
  return scValToNative(result.result!.retval);
}

const bigIntReplacer = (_: string, v: any) => typeof v === "bigint" ? v.toString() : v;

async function main() {
  const oracle = new Contract(ORACLE_ID);
  
  console.log("=== Oracle Contract Investigation ===");
  console.log(`Contract: ${ORACLE_ID}\n`);

  // Try common oracle functions
  const functions = [
    "decimals",
    "resolution", 
    "admin",
    "base",
    "assets",
    "sources",
    "period",
    "last_timestamp",
    "version",
    "config",
    "get_config",
  ];

  for (const fn of functions) {
    try {
      const result = await sim(oracle.call(fn));
      console.log(`${fn}():`, JSON.stringify(result, bigIntReplacer, 2));
    } catch (e) {
      // silent
    }
  }

  // Query lastprice for each asset
  console.log("\n=== Last Prices ===");
  for (const [name, id] of Object.entries(ASSETS)) {
    try {
      const result = await sim(oracle.call("lastprice", assetScVal(id)));
      if (result && !result.error) {
        const price = Number(BigInt(result.price));
        console.log(`${name}: price=${price} (raw), $${price / 1e14} (USD @ 1e14)`);
        if (result.timestamp) console.log(`  timestamp: ${result.timestamp}`);
      } else {
        console.log(`${name}: ${JSON.stringify(result, bigIntReplacer)}`);
      }
    } catch (e) {
      console.log(`${name}: error`);
    }
  }

  // Try to read the contract instance storage directly
  console.log("\n=== Oracle Instance Storage ===");
  const contractIdBytes = (await import("@stellar/stellar-sdk")).StrKey.decodeContract(ORACLE_ID);
  const contractHash = xdr.Hash.fromXDR(Buffer.from(contractIdBytes));
  const contractAddr = xdr.ScAddress.scAddressTypeContract(contractHash);
  
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractAddr,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  
  try {
    const result = await server.getLedgerEntries(ledgerKey);
    if (result.entries?.length) {
      const entry = result.entries[0];
      const raw = (entry.val as any).toXDR("base64");
      const ledgerEntryData = xdr.LedgerEntryData.fromXDR(raw, "base64");
      const contractData = ledgerEntryData.contractData();
      const storedVal = contractData.val();
      if (storedVal.switch().name === "scvContractInstance") {
        const instance = storedVal.contractInstance();
        // Check WASM hash to identify the contract type
        const wasmHash = instance.executable().wasmHash();
        if (wasmHash) {
          console.log("WASM hash:", wasmHash.toString("hex"));
        }
        const storage = instance.storage();
        if (storage) {
          console.log("Instance storage entries:");
          for (const item of storage) {
            const k = scValToNative(item.key());
            const v = scValToNative(item.val());
            console.log(`  [${JSON.stringify(k)}]:`, JSON.stringify(v, bigIntReplacer));
          }
        }
      }
    }
  } catch (e) {
    console.log("Error reading instance:", (e as any).message?.slice(0, 200));
  }
}

main().catch(console.error);
