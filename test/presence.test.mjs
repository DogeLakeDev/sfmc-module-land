import test from "node:test";
import assert from "node:assert/strict";
import harness from "./harness.cjs";

test("presence transitions cover adjacent lands, area fallback, wilderness and logout", async (t) => {
  const rig = await harness.createHarness();
  t.after(() => rig.sql.close());
  const { presenceEvents } = rig.load("runtime/presence.ts");
  const scope = (landId, areaId = "") => ({ landId, areaId });
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const cases = [
    {
      name: "first appearance in wilderness emits nothing",
      from: undefined,
      to: undefined,
      expected: [],
    },
    {
      name: "first appearance in a land enters its current scope",
      from: undefined,
      to: scope("a"),
      expected: [["land.entered", "a", ""]],
    },
    {
      name: "unchanged area emits nothing",
      from: scope("a", "room"),
      to: scope("a", "room"),
      expected: [],
    },
    {
      name: "adjacent lands leave A before entering B",
      from: scope("a"),
      to: scope("b"),
      expected: [
        ["land.left", "a", ""],
        ["land.entered", "b", ""],
      ],
    },
    {
      name: "default area to child leaves the default scope",
      from: scope("a"),
      to: scope("a", "room"),
      expected: [
        ["land.left", "a", ""],
        ["land.entered", "a", "room"],
      ],
    },
    {
      name: "child area to default emits both transitions",
      from: scope("a", "room"),
      to: scope("a"),
      expected: [
        ["land.left", "a", "room"],
        ["land.entered", "a", ""],
      ],
    },
    {
      name: "child area to another child leaves old area first",
      from: scope("a", "room"),
      to: scope("a", "garden"),
      expected: [
        ["land.left", "a", "room"],
        ["land.entered", "a", "garden"],
      ],
    },
    {
      name: "leaving to wilderness emits only left",
      from: scope("a", "room"),
      to: undefined,
      expected: [["land.left", "a", "room"]],
    },
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const events = plain(presenceEvents("player", item.from, item.to));
      assert.deepEqual(
        events.map(({ event, payload }) => [
          event,
          payload.landId,
          payload.areaId,
        ]),
        item.expected,
      );
      for (const { event, payload } of events) {
        assert.equal(payload.playerId, "player");
        assert.equal(payload.reason, "movement");
        if (event === "land.left") {
          assert.equal(payload.toLandId, item.to?.landId ?? "");
          assert.equal(payload.toAreaId, item.to?.areaId ?? "");
        } else {
          assert.equal(payload.fromLandId, item.from?.landId ?? "");
          assert.equal(payload.fromAreaId, item.from?.areaId ?? "");
        }
      }
    });
  }
  await t.test("player-visible notices cover sub-areas and cross-land moves", () => {
    const { presenceNotices } = rig.load("runtime/presence.ts");
    const notices = (from, to) =>
      plain(presenceNotices(from, to)).map(({ kind, scope: s }) => [kind, s.landId, s.areaId]);
    assert.deepEqual(notices(undefined, undefined), []);
    assert.deepEqual(notices(scope("a", "room"), scope("a", "room")), []);
    assert.deepEqual(notices(scope("a"), scope("a", "room")), [["entered_area", "a", "room"]]);
    assert.deepEqual(notices(scope("a", "room"), scope("a")), [["left_area", "a", "room"]]);
    assert.deepEqual(notices(scope("a", "room"), scope("a", "garden")), [
      ["left_area", "a", "room"],
      ["entered_area", "a", "garden"],
    ]);
    assert.deepEqual(notices(scope("a"), scope("b")), [
      ["left", "a", ""],
      ["entered", "b", ""],
    ]);
    assert.deepEqual(notices(scope("a", "room"), scope("b", "hall")), [
      ["left_area", "a", "room"],
      ["left", "a", "room"],
      ["entered", "b", "hall"],
      ["entered_area", "b", "hall"],
    ]);
    assert.deepEqual(notices(undefined, scope("a", "room")), [
      ["entered", "a", "room"],
      ["entered_area", "a", "room"],
    ]);
    assert.deepEqual(notices(scope("a", "room"), undefined), [
      ["left_area", "a", "room"],
      ["left", "a", "room"],
    ]);
  });
  await t.test("logout leaves exactly the previous effective scope", () => {
    const events = plain(
      presenceEvents("player", scope("a", "room"), undefined, "offline"),
    );
    assert.deepEqual(events, [
      {
        event: "land.left",
        payload: {
          playerId: "player",
          landId: "a",
          areaId: "room",
          toLandId: "",
          toAreaId: "",
          reason: "offline",
        },
      },
    ]);
  });
});
