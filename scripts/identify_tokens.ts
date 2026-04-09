/**
 * Identify token symbols and get oracle addresses for each pool.
 */
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  rpc as SorobanRpc,
  scValToNative,
  TransactionBuilder,
  xdr,
  hash,
  StrKey,
} from "@stellar/stellar-sdk";

const RPC_URL = "https://rpc.lightsail.network/";
const NETWORK  = Networks.PUBLIC;
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const server = new SorobanRpc.Server(RPC_URL);

async function sim(op: xdr.Operation): Promise<any> {
  const acc = new Account(NULL_ACCOUNT, "0");
  const tx  = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(op).setTimeout(30).build();
  const result = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(result)) return null;
  return scValToNative(result.result!.retval);
}

const UNKNOWN = [
  "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV",
  "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK",
  "CB226ZOEYXTBPD3QEGABTJYSKZVBP2PASEISLG3SBMTN5CE4QZUVZ3CE",
  "CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2",
];

const POOLS = [
  { name: "Etherfuse",    id: "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI" },
  { name: "Fixed v2",     id: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD" },
  { name: "YieldBlox v2", id: "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS" },
];

// Pool config storage key — Blend v2 stores it as a persistent entry
// Try reading ledger entry with key "PoolConfig" or similar
async function getPoolConfig(poolId: string): Promise<any> {
  const pool = new Contract(poolId);
  // Try "get_config" or direct storage lookup
  // The pool config is stored under the Symbol "PoolConfig" in Soroban persistent storage
  const contractIdBytes = StrKey.decodeContract(poolId);
  const keyScVal = xdr.ScVal.scvLedgerKeyContractInstance();

  // Try to read instance storage which contains the PoolConfig
  const contractHash = xdr.Hash.fromXDR(Buffer.from(contractIdBytes));
  const contractKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: xdr.ScAddress.scAddressTypeContract(contractHash),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );

  try {
    const result = await server.getLedgerEntries(contractKey);
    if (result.entries?.length) {
      const entry = result.entries[0].val.contractData();
      if (entry.val().switch().name === "scvContractInstance") {
        const instance = entry.val().contractInstance();
        const storage = instance.storage();
        if (storage) {
          for (const item of storage) {
            const k = scValToNative(item.key());
            const v = scValToNative(item.val());
            if (k === "PoolConfig" || (typeof k === "object" && k !== null)) {
              console.log(`  Storage[${JSON.stringify(k)}]:`, JSON.stringify(v, (_,x) => typeof x === "bigint" ? x.toString() : x));
            }
          }
        }
      }
    }
  } catch(e) {
    console.log("  getLedgerEntries failed:", e);
  }
}

async function main() {
  // Identify unknown tokens
  console.log("=== TOKEN SYMBOLS ===");
  for (const id of UNKNOWN) {
    const token = new Contract(id);
    const sym  = await sim(token.call("symbol"));
    const name = await sim(token.call("name"));
    console.log(`${id}: symbol=${sym}, name=${name}`);
  }

  // Get oracle for each pool via instance storage
  console.log("\n=== POOL INSTANCE STORAGE ===");
  for (const pool of POOLS) {
    console.log(`\nPool: ${pool.name} (${pool.id})`);
    await getPoolConfig(pool.id);
  }
}

main().catch(console.error);
