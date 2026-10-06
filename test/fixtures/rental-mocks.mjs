export const tables = new Map();
export const calls = [];
export const eventHandlers = new Map();
export const configReads = [];
export const lifecycle = {};
export const runtime = {
  failInsert: "",
  failCredit: false,
  failDebit: false,
  commitReplyLost: false,
};
export const balances = new Map();
const ledger = new Map();
function matches(row, where) {
  if (!where) return true;
  if (where.and) return where.and.every((x) => matches(row, x));
  if (where.eq) return row[where.eq[0]] === where.eq[1];
  if (where.ne) return row[where.ne[0]] !== where.ne[1];
  if (where.in) return where.in[1].includes(row[where.in[0]]);
  if (where.lte) return row[where.lte[0]] <= where.lte[1];
  if (where.lt) return row[where.lt[0]] < where.lt[1];
  throw new Error("unsupported mock predicate");
}
export function reset() {
  tables.clear();
  calls.length = 0;
  configReads.length = 0;
  runtime.failInsert = "";
  runtime.failCredit = false;
  runtime.failDebit = false;
  runtime.commitReplyLost = false;
  balances.clear();
  ledger.clear();
}
export function put(table, row) {
  if (!tables.has(table)) tables.set(table, new Map());
  tables.get(table).set(row.id ?? row.request_id, structuredClone(row));
}
export const db = {
  async tx(run) {
    const snapshot = structuredClone(tables);
    let result;
    try {
      result = await run(db);
    } catch (error) {
      tables.clear();
      for (const [key, value] of snapshot) tables.set(key, value);
      throw error;
    }
    if (runtime.commitReplyLost) {
      runtime.commitReplyLost = false;
      throw new Error("commit reply lost");
    }
    return result;
  },
  async defineTable(table) {
    if (!tables.has(table)) tables.set(table, new Map());
  },
  async get(table, id) {
    const r = tables.get(table)?.get(id);
    return r ? structuredClone(r) : null;
  },
  async query(table, options = {}) {
    let rows = [...(tables.get(table)?.values() ?? [])].filter((row) =>
      matches(row, options.where),
    );
    if (options.orderBy) {
      const { field, dir } = options.orderBy;
      rows.sort((a, b) => (a[field] - b[field]) * (dir === "desc" ? -1 : 1));
    }
    return structuredClone(
      rows.slice(
        options.offset ?? 0,
        (options.offset ?? 0) + (options.limit ?? rows.length),
      ),
    );
  },
  async insert(table, row) {
    if (runtime.failInsert === table)
      throw new Error("injected insert failure");
    if (tables.get(table)?.has(row.id ?? row.request_id))
      throw new Error("duplicate key");
    put(table, row);
  },
  async update(table, id, fields) {
    const old = tables.get(table)?.get(id);
    if (old) put(table, { ...old, ...structuredClone(fields) });
  },
};
export class ServiceError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export const service = {
  async call(name, input) {
    calls.push({ name, input });
    if (name === "activity.query") return { records: [], total: 0 };
    if (name.startsWith("economy.")) {
      const key = input.idempotencyKey;
      if (ledger.has(key))
        return { balance: balances.get(input.accountId), replayed: true };
      if (name.endsWith("debit") && runtime.failDebit)
        throw new Error("insufficient balance");
      if (name.endsWith("credit") && runtime.failCredit)
        throw new Error("credit unavailable");
      const before = balances.get(input.accountId) ?? 1_000_000;
      balances.set(
        input.accountId,
        before + (name.endsWith("debit") ? -input.amount : input.amount),
      );
      ledger.set(key, { name, input });
      return { balance: balances.get(input.accountId) };
    }
    return { ok: true };
  },
  provide() {
    return () => {};
  },
};
export const debug = { w() {}, i() {}, e() {} };
export const Msg = {
  info() {},
  success() {},
  error() {},
  tips() {},
  warning() {},
};
export class Player {}
const owner = {
  id: "owner",
  name: "Owner",
  dimension: { id: "minecraft:overworld" },
  location: { x: 400, y: 70, z: 400 },
  onScreenDisplay: { setTitle() {}, setActionBar() {} },
  teleport() {
    if (runtime.teleportFails) throw new Error("injected teleport failure");
  },
};
function signal(name) {
  return {
    subscribe(cb) {
      eventHandlers.set(name, cb);
      return cb;
    },
    unsubscribe() {
      eventHandlers.delete(name);
    },
  };
}
export const world = {
  getAllPlayers: () => [owner],
  getDimension: (id) => ({ id, spawnParticle() {} }),
  afterEvents: {
    playerLeave: signal("afterLeave"),
    playerPlaceBlock: signal("afterPlace"),
    playerInteractWithBlock: signal("afterInteract"),
    entitySpawn: signal("afterSpawn"),
  },
  beforeEvents: { explosion: signal("beforeExplosion") },
};
export const system = {
  runTimeout() {
    return 1;
  },
  runInterval() {
    return 1;
  },
  clearRun() {},
};
export const config = {
  async getAll() {
    return {};
  },
  async get(key) {
    configReads.push(key);
    return undefined;
  },
};
export const Command = { register() {} };
export const Permission = { Any: 0, OP: 2, register() {} };
export const ModuleRegistry = {
  register(def) {
    Object.assign(lifecycle, def.lifecycle);
  },
};
export const ui = {
  registerFeature() {
    return () => {};
  },
  async openScreen() {},
};
