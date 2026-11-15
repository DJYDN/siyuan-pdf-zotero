import test from "node:test";
import assert from "node:assert/strict";
import {Store} from "../../.test-build/storage.mjs";

function parseData(value) {
    return typeof value === "string" ? JSON.parse(value) : value;
}

function fakePlugin() {
    const data = {};
    return {
        data,
        async loadData(key) {
            return data[key] ?? "";
        },
        async saveData(key, value) {
            data[key] = value;
            return {code: 0};
        },
    };
}

test("Store writes and rotates backup on load", async () => {
    const plugin = fakePlugin();
    const store = new Store(plugin);
    store.state.books["book-1"] = {
        id: "book-1", title: "Backup marker", authors: [], source: "local",
        createdAt: 1, updatedAt: 1,
    };
    await store.save();
    await store.backupNow();
    assert.ok(plugin.data["state-backup-1"]);
    assert.equal(parseData(plugin.data["state-backup-1"]).books["book-1"].title, "Backup marker");

    const loaded = new Store(plugin);
    await loaded.load();
    assert.equal(loaded.state.books["book-1"].title, "Backup marker");
    assert.equal(loaded.recoveredFromBackup, "");
    assert.ok(plugin.data["state-backup-1"]);
});

test("Store recovers a corrupted primary state from backup-1", async () => {
    const plugin = fakePlugin();
    const store = new Store(plugin);
    store.state.books["book-recover"] = {
        id: "book-recover", title: "Recovered book", authors: [], source: "local",
        createdAt: 1, updatedAt: 1,
    };
    await store.save();
    await store.backupNow();

    plugin.data["state-v1"] = "{ this is not valid json";
    const recovered = new Store(plugin);
    await recovered.load();

    assert.equal(recovered.recoveredFromBackup, "state-backup-1");
    assert.equal(recovered.state.books["book-recover"].title, "Recovered book");
    const written = parseData(plugin.data["state-v1"]);
    assert.equal(written.books["book-recover"].title, "Recovered book");
});

test("Store recovers matrix state from the migration backup", async () => {
    const plugin = fakePlugin();
    const store = new Store(plugin);
    store.state.matrixProjects = [{
        id: "mx-recover", name: "Recovered matrix", collectionKeys: [], columns: [], rows: [],
        views: [], schemaVersion: 1, schemaReviewed: true, createdAt: 1, updatedAt: 1,
    }];
    await store.save();
    await store.backupNow();
    plugin.data["state-v1"] = "not json";
    plugin.data["matrix-migration-backup-v1"] = plugin.data["state-backup-1"];
    delete plugin.data["state-backup-1"];
    delete plugin.data["state-backup-2"];

    const recovered = new Store(plugin);
    await recovered.load();

    assert.equal(recovered.recoveredFromBackup, "matrix-migration-backup-v1");
    assert.equal(recovered.state.matrixProjects[0].name, "Recovered matrix");
});

test("Store falls back to defaults when primary and backups are unusable", async () => {
    const plugin = fakePlugin();
    plugin.data["state-v1"] = "not json";
    plugin.data["state-backup-1"] = "also not json";
    plugin.data["state-backup-2"] = "{broken";
    const store = new Store(plugin);
    await store.load();
    assert.deepEqual(store.state.books, {});
    assert.equal(store.recoveredFromBackup, "");
});
