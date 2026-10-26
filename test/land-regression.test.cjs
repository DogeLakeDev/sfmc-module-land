const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, deferred } = require("./harness.cjs");

const owner = { id: "owner", name: "甲", admin: false, console: false };
const buyer = { id: "buyer", name: "乙", admin: false, console: false };
const here = {
  dimensionId: "minecraft:overworld",
  x: 1,
  y: 64,
  z: 1,
  yaw: 0,
  pitch: 0,
};

async function fixture(t) {
  const rig = await createHarness();
  t.after(() => rig.sql.close());
  rig.economy.balances.set(owner.id, 10000);
  rig.economy.balances.set(buyer.id, 10000);
  return rig;
}

async function land(rig, name = "测试领地", actor = owner, spot = here) {
  return rig.load("services/territory.ts").createLand(actor, name, "", spot);
}

async function shop(rig) {
  const parent = await land(rig);
  const area = await rig
    .load("services/territory.ts")
    .createArea(
      owner,
      parent.id,
      "商铺区域",
      { dimensionId: here.dimensionId, x: 0, y: 60, z: 0 },
      { dimensionId: here.dimensionId, x: 5, y: 65, z: 5 },
    );
  return { parent, area };
}

async function recover(rig) {
  await rig
    .load("economy/ledger.ts")
    .recoverTransactions(await rig.repo.listTransactions());
}

test("creation recovery rejects a chunk claimed by a later land", async (t) => {
  const rig = await fixture(t);
  rig.faults.set("db.update", ({ table, patch }) => {
    if (table === "land2_tx" && patch.status === "debited")
      throw new Error("payment acknowledged, process interrupted");
  });
  await assert.rejects(land(rig, "待恢复领地"));
  rig.faults.clear();
  const restarted = await rig.restart();
  const later = await land(restarted, "后来领地", buyer);
  await recover(restarted);
  const claim = (await restarted.repo.listClaims())[0];
  assert.equal(claim.landId, later.id);
  assert.equal(restarted.index.claims.get(claim.key), later.id);
  assert.equal(restarted.index.lands.size, 1);
  assert.equal(restarted.economy.balances.get(owner.id), 10000);
});

test("creation recovery preserves an existing land after its original chunk was legitimately released", async (t) => {
  const rig = await fixture(t);
  const original = await land(rig);
  const creation = (await rig.repo.listTransactions()).find(
    (tx) => tx.kind === "land.create",
  );
  await rig.repo.updateTx({ ...creation, status: "debited" });
  const territory = rig.load("services/territory.ts");
  await territory.claimChunks(owner, original.id, [
    { dimensionId: here.dimensionId, chunkX: 1, chunkZ: 0 },
  ]);
  await territory.unclaimChunks(owner, original.id, [
    { dimensionId: here.dimensionId, chunkX: 0, chunkZ: 0 },
  ]);
  const later = await land(rig, "后来领地", buyer);
  await recover(rig);
  assert.equal(rig.economy.balances.get(owner.id), 9900);
  assert.equal(rig.index.claims.get("minecraft:overworld|0|0"), later.id);
  assert.equal(rig.index.claims.get("minecraft:overworld|1|0"), original.id);
  assert.equal(
    (await rig.repo.listTransactions()).find((tx) => tx.id === creation.id)
      .status,
    "applied",
  );
});

for (const sameLand of [false, true]) {
  test(`unclaim replay preserves a new claim record (${sameLand ? "same" : "different"} land)`, async (t) => {
    const rig = await fixture(t);
    const original = await land(rig);
    const territory = rig.load("services/territory.ts");
    const chunk = { dimensionId: here.dimensionId, chunkX: 1, chunkZ: 0 };
    await territory.claimChunks(owner, original.id, [chunk]);
    await territory.unclaimChunks(owner, original.id, [chunk]);
    const oldTx = (await rig.repo.listTransactions()).find(
      (tx) => tx.kind === "land.unclaim",
    );
    // A pre-fix crash could leave this marker behind after the claim was released.
    await rig.repo.updateTx({ ...oldTx, status: "debited" });
    const current = sameLand
      ? original
      : await land(rig, "后来领地", buyer, { ...here, x: 17 });
    if (sameLand) await territory.claimChunks(owner, current.id, [chunk]);
    const idBefore = rig.index.claimIds.get("minecraft:overworld|1|0");
    await recover(rig);
    const claim = (await rig.repo.listClaims()).find(
      (row) => row.key === "minecraft:overworld|1|0",
    );
    assert.equal(claim.id, idBefore);
    assert.equal(claim.landId, current.id);
    assert.equal(rig.index.claimIds.get(claim.key), idBefore);
    assert.equal(rig.index.claims.get(claim.key), current.id);
  });
}

test("purchase failure rolls ownership, membership, and listing back before refund", async (t) => {
  const rig = await fixture(t);
  const parent = await land(rig);
  const market = rig.load("services/market.ts");
  const listing = await market.publishLandSale(owner, parent.id, 100);
  rig.faults.set("db.update", ({ table, patch }) => {
    if (table === "land2_listing" && patch.status === "sold")
      throw new Error("listing write failed");
  });
  await assert.rejects(market.buy(buyer, parent.id));
  assert.equal(rig.index.lands.get(parent.id).ownerId, owner.id);
  assert.equal((await rig.repo.listLands())[0].ownerId, owner.id);
  assert.equal((await rig.repo.listListings())[0].status, "open");
  assert.equal(rig.index.listings.get(listing.id).status, "open");
  assert.equal((await rig.repo.listMembers()).length, 0);
  assert.equal(rig.economy.balances.get(buyer.id), 10000);
  rig.faults.clear();
  await market.buy(buyer, parent.id);
  assert.equal(rig.index.lands.get(parent.id).ownerId, buyer.id);
  assert.equal(rig.economy.balances.get(buyer.id), 9900);
});

test("a committed purchase is never refunded when the commit acknowledgement is lost", async (t) => {
  const rig = await fixture(t);
  const parent = await land(rig);
  const market = rig.load("services/market.ts");
  await market.publishLandSale(owner, parent.id, 100);
  let once = true;
  rig.faults.set("db.afterCommit", () => {
    if (once) {
      once = false;
      throw new Error("commit acknowledgement lost");
    }
  });
  await market.buy(buyer, parent.id).catch(() => {});
  rig.faults.clear();
  const restarted = await rig.restart();
  await recover(restarted);
  assert.equal((await restarted.repo.listLands())[0].ownerId, buyer.id);
  assert.equal(restarted.economy.balances.get(buyer.id), 9900);
  assert.equal(
    (await restarted.repo.listTransactions()).find(
      (tx) => tx.kind === "land.buy",
    ).status,
    "applied",
  );
});

test("a purchase ledger-marker failure rolls all local ownership changes back", async (t) => {
  const rig = await fixture(t);
  const parent = await land(rig);
  const market = rig.load("services/market.ts");
  await market.publishLandSale(owner, parent.id, 100);
  rig.faults.set("db.update", ({ table, patch, transactional }) => {
    if (table === "land2_tx" && patch.status === "applied" && transactional)
      throw new Error("success marker write failed");
  });
  await assert.rejects(market.buy(buyer, parent.id));
  assert.equal((await rig.repo.listLands())[0].ownerId, owner.id);
  assert.equal(rig.index.lands.get(parent.id).ownerId, owner.id);
  assert.equal((await rig.repo.listMembers()).length, 0);
  assert.equal((await rig.repo.listListings())[0].status, "open");
  assert.equal(rig.economy.balances.get(buyer.id), 10000);
});

test("committed purchase publication failure rebuilds the protection index without refunding", async (t) => {
  const rig = await fixture(t);
  const parent = await land(rig);
  const market = rig.load("services/market.ts");
  await market.publishLandSale(owner, parent.id, 100);
  const publish = rig.index.upsertLand.bind(rig.index);
  rig.index.upsertLand = (next) => {
    if (next.ownerId === buyer.id) {
      rig.index.upsertLand = publish;
      throw new Error("cache publication interrupted");
    }
    return publish(next);
  };
  await assert.rejects(market.buy(buyer, parent.id));
  assert.equal(rig.economy.balances.get(buyer.id), 9900);
  assert.equal(rig.index.ready, true);
  assert.equal(rig.index.lands.get(parent.id).ownerId, buyer.id);
  assert.equal(
    (await rig.repo.listTransactions()).find((tx) => tx.kind === "land.buy")
      .status,
    "applied",
  );
});

test("recovery completes a legacy lease whose row exists without a grant or closed listing", async (t) => {
  const rig = await fixture(t);
  const { parent, area } = await shop(rig);
  const listing = await rig
    .load("services/market.ts")
    .publishRent(owner, parent.id, area.id, 20, 60000);
  const now = Date.now();
  const lease = {
    id: "legacy-lease",
    areaId: area.id,
    landId: parent.id,
    tenantId: buyer.id,
    tenantName: buyer.name,
    price: 20,
    periodMs: 60000,
    startAt: now,
    endAt: now + 60000,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const tx = {
    id: "legacy-rent-tx",
    idempotencyKey: `rent:${listing.id}:${buyer.id}`,
    kind: "land.rent",
    status: "debited",
    landId: parent.id,
    actorId: buyer.id,
    fromAccount: buyer.id,
    toAccount: parent.bankAccount,
    amount: 20,
    payloadJson: JSON.stringify({
      lease,
      listingId: listing.id,
      mode: "transfer",
    }),
    error: "",
    economyTxId: "legacy-pay",
    createdAt: now,
    updatedAt: now,
  };
  await rig.repo.insertLease(lease);
  await rig.repo.insertTx(tx);
  const restarted = await rig.restart();
  await recover(restarted);
  await recover(restarted);
  assert.equal(restarted.index.activeLeases.get(area.id).id, lease.id);
  assert.equal((await restarted.repo.listAreaRoles()).length, 1);
  assert.equal(
    restarted.index.areaRoles.get(`${area.id}|${buyer.id}`).roleId,
    restarted
      .load("services/shared.ts")
      .roleByPreset(restarted.index.rolesOf(parent.id), "tenant").id,
  );
  assert.equal(restarted.index.listings.get(listing.id).status, "closed");
  assert.equal(
    (await restarted.repo.listTransactions()).find((row) => row.id === tx.id)
      .status,
    "applied",
  );
});

test("rental grant failure rolls the entire lease back", async (t) => {
  const rig = await fixture(t);
  const { parent, area } = await shop(rig);
  const market = rig.load("services/market.ts");
  const listing = await market.publishRent(
    owner,
    parent.id,
    area.id,
    20,
    60000,
  );
  rig.faults.set("db.insert", ({ table }) => {
    if (table === "land2_area_role") throw new Error("grant failed");
  });
  await assert.rejects(market.takeLease(buyer, parent.id, area.id));
  assert.equal((await rig.repo.listLeases()).length, 0);
  assert.equal(rig.index.activeLeases.size, 0);
  assert.equal(rig.index.listings.get(listing.id).status, "open");
  assert.equal(rig.economy.balances.get(buyer.id), 10000);
});

test("upkeep and ownership transfer are serialized without restoring the old owner", async (t) => {
  const rig = await fixture(t);
  const parent = await land(rig);
  await rig.repo.patchLand(parent.id, { nextUpkeepAt: 1 });
  rig.index.upsertLand({ ...parent, nextUpkeepAt: 1 });
  rig.economy.balances.set(parent.bankAccount, 100);
  const entered = deferred();
  const release = deferred();
  rig.faults.set("money.debitAccount", async (input) => {
    if (input.reason === "land.upkeep") {
      entered.resolve();
      await release.promise;
    }
  });
  const settling = rig.load("services/finance.ts").settleUpkeep(parent);
  await entered.promise;
  const transferring = rig
    .load("services/territory.ts")
    .transferLand(owner, parent.id, buyer);
  await Promise.resolve();
  assert.equal(rig.index.lands.get(parent.id).ownerId, owner.id);
  release.resolve();
  await Promise.all([settling, transferring]);
  assert.equal(rig.index.lands.get(parent.id).ownerId, buyer.id);
  assert.equal((await rig.repo.listLands())[0].ownerId, buyer.id);
  await rig.load("services/finance.ts").settleTax(parent);
  assert.equal((await rig.repo.listLands())[0].ownerId, buyer.id);
});

test("deletion waits for area creation and removes its newly committed graph", async (t) => {
  const rig = await fixture(t);
  const parent = await land(rig);
  const territory = rig.load("services/territory.ts");
  const entered = deferred();
  const release = deferred();
  rig.beforeHooks.set("land.before.area", async () => {
    entered.resolve();
    await release.promise;
  });
  const creating = territory.createArea(
    owner,
    parent.id,
    "区域甲",
    { ...here, x: 0, y: 60, z: 0 },
    { ...here, x: 5, y: 65, z: 5 },
  );
  await entered.promise;
  const deleting = territory.deleteLand(owner, parent.id);
  const afterDeletion = territory.createArea(
    owner,
    parent.id,
    "区域乙",
    { ...here, x: 8, y: 60, z: 0 },
    { ...here, x: 10, y: 65, z: 5 },
  );
  const rejected = assert.rejects(
    afterDeletion,
    (error) => error.key === "land_not_found",
  );
  release.resolve();
  await Promise.all([creating, deleting, rejected]);
  assert.equal(rig.index.lands.size, 0);
  assert.equal(rig.index.areas.size, 0);
  assert.equal((await rig.repo.listAreas()).length, 0);
  assert.equal((await rig.repo.listClaims()).length, 0);
});

test("lease expiry rollback remains retryable after a restart", async (t) => {
  const rig = await fixture(t);
  const { parent, area } = await shop(rig);
  const market = rig.load("services/market.ts");
  await market.publishRent(owner, parent.id, area.id, 20, 60000);
  await market.takeLease(buyer, parent.id, area.id);
  rig.faults.set("db.delete", ({ table }) => {
    if (table === "land2_area_role") throw new Error("revoke failed");
  });
  await assert.rejects(market.expireLeases(Date.now() + 120000));
  assert.equal((await rig.repo.listLeases())[0].status, "active");
  rig.faults.clear();
  const restarted = await rig.restart();
  await restarted.load("services/market.ts").expireLeases(Date.now() + 120000);
  assert.equal((await restarted.repo.listAreaRoles()).length, 0);
  assert.equal(restarted.index.activeLeases.size, 0);
  const located = restarted.index.locate(here.dimensionId, 1, 64, 1);
  assert.equal(
    restarted
      .load("services/permission.ts")
      .decide(restarted.index, buyer, "block.break", located, false).allow,
    false,
  );
});

test("expiry repairs a legacy ended lease with a residual tenant grant", async (t) => {
  const rig = await fixture(t);
  const { parent, area } = await shop(rig);
  const market = rig.load("services/market.ts");
  await market.publishRent(owner, parent.id, area.id, 20, 60000);
  await market.takeLease(buyer, parent.id, area.id);
  const lease = (await rig.repo.listLeases())[0];
  await rig.repo.updateLease({ ...lease, status: "expired" });
  const restarted = await rig.restart();
  assert.equal(restarted.index.activeLeases.size, 0);
  assert.equal(restarted.index.areaRoles.size, 1);
  await restarted.load("services/market.ts").expireLeases(Date.now() + 120000);
  assert.equal(restarted.index.areaRoles.size, 0);
  assert.equal((await restarted.repo.listAreaRoles()).length, 0);
});

test("upgrade reward failure retries rewards without refunding a committed level", async (t) => {
  const rig = await fixture(t);
  const parent = await land(rig);
  Object.assign(rig.config.levels[1], {
    minChunks: 1,
    minMembers: 0,
    cost: 100,
    reward: 10,
  });
  rig.economy.balances.set(parent.bankAccount, 200);
  rig.faults.set("money.creditAccount", (input) => {
    if (input.reason === "land.upgrade.reward")
      throw new Error("reward unavailable");
  });
  await assert.rejects(
    rig.load("services/finance.ts").upgradeLand(owner, parent.id),
  );
  assert.equal(rig.index.lands.get(parent.id).level, 2);
  assert.equal(rig.economy.balances.get(parent.bankAccount), 100);
  rig.faults.clear();
  await recover(rig);
  await recover(rig);
  assert.equal(rig.economy.balances.get(parent.bankAccount), 110);
  assert.equal(
    (await rig.repo.listTransactions()).find((tx) => tx.kind === "land.upgrade")
      .status,
    "applied",
  );
});

test("upgrade cache publication failure never refunds an already persisted level", async (t) => {
  const rig = await fixture(t);
  const parent = await land(rig);
  Object.assign(rig.config.levels[1], {
    minChunks: 1,
    minMembers: 0,
    cost: 100,
    reward: 10,
  });
  rig.economy.balances.set(parent.bankAccount, 200);
  const publish = rig.index.upsertLand.bind(rig.index);
  rig.index.upsertLand = (next) => {
    if (next.level === 2) {
      rig.index.upsertLand = publish;
      throw new Error("cache publication interrupted");
    }
    return publish(next);
  };
  await assert.rejects(
    rig.load("services/finance.ts").upgradeLand(owner, parent.id),
  );
  assert.equal((await rig.repo.listLands())[0].level, 2);
  assert.equal(rig.economy.balances.get(parent.bankAccount), 100);
  const restarted = await rig.restart();
  await recover(restarted);
  assert.equal(restarted.economy.balances.get(parent.bankAccount), 110);
  assert.equal(
    (await restarted.repo.listTransactions()).find(
      (tx) => tx.kind === "land.upgrade",
    ).status,
    "applied",
  );
});

test("external upgrade rewards receive a stable idempotency key across recovery", async (t) => {
  const rig = await fixture(t);
  const parent = await land(rig);
  Object.assign(rig.config.levels[1], {
    minChunks: 1,
    minMembers: 0,
    cost: 100,
    reward: 0,
  });
  rig.economy.balances.set(parent.bankAccount, 200);
  await rig
    .load("services/registry.ts")
    .registerUpgradeReward("external", "test.reward");
  const keys = new Set();
  let calls = 0;
  rig.handlers.set("test.reward", (input) => {
    calls += 1;
    assert.equal(typeof input.idempotencyKey, "string");
    assert.ok(input.idempotencyKey.length > 0);
    keys.add(input.idempotencyKey);
    return { ok: true };
  });
  let fail = true;
  rig.faults.set("db.insert", ({ table, row }) => {
    if (table === "land2_reward" && row.reward_id === "external" && fail) {
      fail = false;
      throw new Error("reward acknowledgement interrupted");
    }
  });
  await assert.rejects(
    rig.load("services/finance.ts").upgradeLand(owner, parent.id),
  );
  await recover(rig);
  assert.equal(calls, 2);
  assert.equal(keys.size, 1);
  assert.equal(
    (await rig.repo.listTransactions()).find((tx) => tx.kind === "land.upgrade")
      .status,
    "applied",
  );
});

test("lease and listing failures report the real reason instead of land_not_found", async (t) => {
  const rig = await fixture(t);
  const { parent, area } = await shop(rig);
  const market = rig.load("services/market.ts");
  const fails = (promise, key, check = () => true) =>
    assert.rejects(promise, (error) => error.key === key && check(error.vars));

  await fails(market.takeLease(buyer, parent.id, area.id), "rent_not_found", (vars) => vars.name === area.name);
  await fails(market.cancelListing(owner, parent.id, area.id), "listing_not_found");
  await market.publishRent(owner, parent.id, area.id, 20, 3_600_000 * 5);
  // 领主自租在检查挂牌之前就拒绝
  await fails(market.takeLease(owner, parent.id, area.id), "rent_owner");
  await market.takeLease(buyer, parent.id, area.id);
  await fails(
    market.takeLease(buyer, parent.id, area.id),
    "rent_taken",
    (vars) => vars.name === area.name && vars.tenant === buyer.name && vars.hours === 5,
  );
  await market.endLease(buyer, parent.id, area.id);
  await fails(market.endLease(buyer, parent.id, area.id), "lease_not_found");
  await fails(market.renewLease(buyer, parent.id, area.id), "lease_not_found");
  await fails(market.takeLease(buyer, parent.id, area.id), "rent_not_found");
  await fails(market.buy(buyer, parent.id, area.id), "listing_not_found");
});
