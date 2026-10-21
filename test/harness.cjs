const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");
const ts = require("typescript");

const sourceRoot = path.resolve(__dirname, "../sapi/src");

function identifier(value) {
  if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(value))
    throw new Error(`Invalid SQL identifier: ${value}`);
  return `"${value}"`;
}

function predicate(where, values) {
  if (!where) return "1";
  if (where.eq) {
    values.push(where.eq[1]);
    return `${identifier(where.eq[0])} = ?`;
  }
  for (const op of ["and", "or"]) {
    if (where[op])
      return `(${where[op].map((item) => predicate(item, values)).join(` ${op.toUpperCase()} `)})`;
  }
  throw new Error(`Unsupported test query: ${JSON.stringify(where)}`);
}

/** Runs the production repository/codec against SQLite; only platform boundaries are substituted. */
async function createHarness(options = {}) {
  const sql = options.database ?? new DatabaseSync(":memory:");
  const definitions = new Map();
  const faults = new Map();
  const events = [];
  const messages = [];
  const players = [];
  const callbacks = new Map();
  const handlers = new Map();
  const beforeHooks = new Map();
  const economy = options.economy ?? {
    balances: new Map(),
    keys: new Map(),
    requests: [],
  };
  let inTransaction = false;
  let intervalId = 0;

  async function intercept(operation, input) {
    const handler = faults.get(operation);
    if (handler) await handler(input);
  }

  function primary(table) {
    const columns = definitions.get(table);
    return Object.keys(columns).find((key) => columns[key].primary) ?? "id";
  }

  function store(transactional) {
    async function check(operation, input) {
      if (inTransaction && !transactional)
        throw new Error(
          "SDK use_tx: database access must use the transaction context",
        );
      await intercept(operation, { ...input, transactional });
    }
    return {
      async query(table, opts = {}) {
        await check("db.query", { table, opts });
        const values = [];
        return sql
          .prepare(
            `SELECT * FROM ${identifier(table)} WHERE ${predicate(opts.where, values)}`,
          )
          .all(...values);
      },
      async get(table, id) {
        await check("db.get", { table, id });
        return sql
          .prepare(
            `SELECT * FROM ${identifier(table)} WHERE ${identifier(primary(table))} = ?`,
          )
          .get(id);
      },
      async insert(table, row) {
        await check("db.insert", { table, row });
        const keys = Object.keys(row);
        sql
          .prepare(
            `INSERT INTO ${identifier(table)} (${keys.map(identifier).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
          )
          .run(...keys.map((key) => row[key]));
        return row;
      },
      async update(table, id, patch) {
        await check("db.update", { table, id, patch });
        const keys = Object.keys(patch);
        if (keys.length)
          sql
            .prepare(
              `UPDATE ${identifier(table)} SET ${keys.map((key) => `${identifier(key)} = ?`).join(",")} WHERE ${identifier(primary(table))} = ?`,
            )
            .run(...keys.map((key) => patch[key]), id);
        return id;
      },
      async delete(table, id) {
        await check("db.delete", { table, id });
        sql
          .prepare(
            `DELETE FROM ${identifier(table)} WHERE ${identifier(primary(table))} = ?`,
          )
          .run(id);
      },
    };
  }

  const db = {
    ...store(false),
    async defineTable(table, columns) {
      definitions.set(table, columns);
      const declarations = Object.entries(columns).map(([key, def]) => {
        const value = def.default;
        const fallback =
          value === undefined
            ? ""
            : ` DEFAULT ${typeof value === "number" ? value : `'${String(value).replaceAll("'", "''")}'`}`;
        return `${identifier(key)} ${def.type}${def.primary ? " PRIMARY KEY" : ""}${def.notNull ? " NOT NULL" : ""}${def.unique ? " UNIQUE" : ""}${fallback}`;
      });
      sql.exec(
        `CREATE TABLE IF NOT EXISTS ${identifier(table)} (${declarations.join(",")})`,
      );
    },
    async tx(fn) {
      if (inTransaction) throw new Error("SDK nested_tx");
      await intercept("db.begin", {});
      sql.exec("BEGIN");
      inTransaction = true;
      let committed = false;
      try {
        const result = await fn(store(true));
        await intercept("db.commit", {});
        sql.exec("COMMIT");
        committed = true;
        inTransaction = false;
        await intercept("db.afterCommit", {});
        return result;
      } catch (error) {
        if (!committed) sql.exec("ROLLBACK");
        inTransaction = false;
        throw error;
      }
    },
  };

  const gateway = {
    async getBalance(accountId) {
      await intercept("money.balance", { accountId });
      return economy.balances.get(accountId) ?? 0;
    },
  };
  for (const method of ["debitAccount", "creditAccount", "transferAccounts"]) {
    gateway[method] = async (input) => {
      await intercept(`money.${method}`, input);
      economy.requests.push({ method, ...input });
      const existing = economy.keys.get(input.idempotencyKey);
      if (existing) return { ...existing, replayed: true };
      const from =
        method === "debitAccount"
          ? input.accountId
          : method === "transferAccounts"
            ? input.fromAccount
            : "";
      const to =
        method === "creditAccount"
          ? input.accountId
          : method === "transferAccounts"
            ? input.toAccount
            : "";
      if (
        (!from && method !== "creditAccount") ||
        (!to && method !== "debitAccount")
      )
        throw new Error("Invalid economy account");
      const balance = economy.balances.get(from) ?? 0;
      if (from && balance < input.amount)
        return {
          ok: false,
          code: "insufficient_funds",
          message: "Insufficient funds",
        };
      if (from) economy.balances.set(from, balance - input.amount);
      if (to)
        economy.balances.set(
          to,
          (economy.balances.get(to) ?? 0) + input.amount,
        );
      const result = {
        ok: true,
        transactionId: input.idempotencyKey,
        replayed: false,
      };
      economy.keys.set(input.idempotencyKey, result);
      return result;
    };
  }

  const signal = (name) => ({
    subscribe(fn) {
      callbacks.set(name, fn);
      return fn;
    },
    unsubscribe() {
      callbacks.delete(name);
    },
  });
  const minecraft = {
    world: {
      getAllPlayers: () => players,
      getDimension(id) {
        if (
          ![
            "overworld",
            "nether",
            "the_end",
            "minecraft:overworld",
            "minecraft:nether",
            "minecraft:the_end",
          ].includes(id)
        )
          throw new Error("Invalid dimension");
        return { id: id.startsWith("minecraft:") ? id : `minecraft:${id}` };
      },
      beforeEvents: new Proxy({}, { get: (_, name) => signal(name) }),
      afterEvents: new Proxy({}, { get: (_, name) => signal(name) }),
    },
    system: {
      run: (fn) => fn(),
      runInterval(fn) {
        const id = intervalId++;
        callbacks.set(id, fn);
        return id;
      },
      clearRun: (id) => callbacks.delete(id),
    },
  };
  const hooks = {
    async beforeEvent(event, payload) {
      await intercept("beforeEvent", { event, payload });
      const handler = beforeHooks.get(event);
      if (handler) await handler(payload);
    },
    async afterEvent(event, payload) {
      events.push({ event, ...payload });
    },
  };
  const service = {
    provide(name, handler) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    async call(name, input) {
      if (inTransaction) throw new Error("SDK use_tx_call");
      await intercept("service.call", { name, input });
      return handlers.has(name) ? handlers.get(name)(input) : {};
    },
  };
  const runtime = {
    Permission: { check: (player) => Boolean(player.admin) },
    debug: { i() {}, w() {} },
    Msg: { info() {} },
  };
  const mocks = {
    "@minecraft/server": minecraft,
    "@sfmc-bds/sdk/sapi/db": { db },
    "@sfmc-bds/sdk/sapi/runtime": runtime,
    "@sfmc-bds/sdk/sapi/service": {
      service,
      ServiceError: class ServiceError extends Error {},
    },
    "economy/gateway.ts": gateway,
    "services/hooks.ts": hooks,
    "messages/speak.ts": {
      say: (player, ...args) => messages.push(args),
      sayError: (player, error) =>
        messages.push({ error: error.key ?? error.message }),
      rememberLocale() {},
    },
  };
  const modules = new Map();
  const context = vm.createContext({
    console,
    Date,
    Math,
    structuredClone,
    Map,
    Set,
    Error,
    JSON,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Promise,
  });
  function load(file) {
    if (mocks[file]) return mocks[file];
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} };
    modules.set(file, module);
    const source = fs.readFileSync(path.join(sourceRoot, file), "utf8");
    const js = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const requireModule = (specifier) => {
      if (mocks[specifier]) return mocks[specifier];
      return load(
        path.posix
          .normalize(path.posix.join(path.posix.dirname(file), specifier))
          .replace(/\.js$/, ".ts"),
      );
    };
    new vm.Script(`(function(require,module,exports){${js}\n})`, {
      filename: file,
    }).runInContext(context)(requireModule, module, module.exports);
    return module.exports;
  }
  const index = new (load("cache/world-index.ts").WorldIndex)();
  const config = load("config.ts").mergeLandConfig();
  load("services/shared.ts").bindShared(index, config, () => false);
  await load("store/tables.ts").defineLandTables();
  await load("store/hydrate.ts").hydrate(index);
  load("economy/appliers.ts");
  return {
    load,
    index,
    config,
    db,
    sql,
    faults,
    events,
    players,
    callbacks,
    beforeHooks,
    handlers,
    messages,
    economy,
    repo: load("store/repo.ts"),
    async restart() {
      return createHarness({ database: sql, economy });
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

module.exports = { createHarness, deferred };
