import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

globalThis.__pzNodeRequire = createRequire(import.meta.url);
const {DatabaseSync} = await import("node:sqlite");
const {readOfflineLibrary, searchOfflineFulltext, offlineSqliteStatus} = await import("../../.test-build/zotero-offline.mjs");

function hasFts5() {
    try {
        const db = new DatabaseSync(":memory:");
        const row = db.prepare("select sqlite_compileoption_used('ENABLE_FTS5') as v").get();
        db.close();
        return Number(row?.v) === 1;
    } catch {
        return false;
    }
}

function makeZoteroFixture(withFulltext = false) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-zotero-"));
    const db = new DatabaseSync(path.join(dir, "zotero.sqlite"));
    db.exec(`
        CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
        CREATE TABLE items (itemID INTEGER PRIMARY KEY, key TEXT, itemTypeID INTEGER, libraryID INTEGER);
        CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY);
        CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
        CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value TEXT);
        CREATE TABLE itemData (itemID INTEGER, fieldID INTEGER, valueID INTEGER);
        CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, fieldMode INTEGER);
        CREATE TABLE creatorTypes (creatorTypeID INTEGER PRIMARY KEY, creatorType TEXT);
        CREATE TABLE itemCreators (itemID INTEGER, creatorID INTEGER, creatorTypeID INTEGER, orderIndex INTEGER);
        CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, key TEXT, collectionName TEXT, parentCollectionID INTEGER);
        CREATE TABLE collectionItems (collectionID INTEGER, itemID INTEGER);
        CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INTEGER, path TEXT, contentType TEXT);
    `);
    db.exec(`
        INSERT INTO itemTypes VALUES (1,'journalArticle'),(2,'attachment');
        INSERT INTO items VALUES (100,'PARENT01',1,1),(101,'ATTACH01',2,1),(102,'DELETED01',1,1);
        INSERT INTO deletedItems VALUES (102);
        INSERT INTO fields VALUES (1,'title'),(2,'date'),(3,'DOI'),(4,'abstractNote');
        INSERT INTO itemDataValues VALUES (10,'A study of robots'),(11,'2024-05-01'),(12,'10.1/test'),(13,'abstract text');
        INSERT INTO itemData VALUES (100,1,10),(100,2,11),(100,3,12),(100,4,13);
        INSERT INTO creators VALUES (1,'Alice','Smith',0);
        INSERT INTO creatorTypes VALUES (1,'author');
        INSERT INTO itemCreators VALUES (100,1,1,0);
        INSERT INTO collections VALUES (1,'COLL01','Robotics',NULL);
        INSERT INTO collectionItems VALUES (1,100);
        INSERT INTO itemAttachments VALUES (101,100,'storage:paper.pdf','application/pdf');
    `);
    db.close();
    if (withFulltext) {
        const ft = new DatabaseSync(path.join(dir, "fulltext.sqlite"));
        ft.exec("CREATE VIRTUAL TABLE fulltextContent USING fts5(text)");
        ft.exec("INSERT INTO fulltextContent(rowid, text) VALUES (101, 'robot energy harvesting polymer')");
        ft.close();
    }
    return dir;
}

test("readOfflineLibrary maps items, creators, collections and attachments", () => {
    const dir = makeZoteroFixture();
    assert.equal(offlineSqliteStatus(dir).available, true);
    const library = readOfflineLibrary(dir);
    assert.ok(library);
    assert.equal(library.items.length, 1);
    const item = library.items[0];
    assert.equal(item.key, "PARENT01");
    assert.equal(item.title, "A study of robots");
    assert.equal(item.year, "2024");
    assert.deepEqual(item.creators, ["Smith, Alice"]);
    assert.deepEqual(item.collections, ["COLL01"]);
    assert.equal(item.doi, "10.1/test");
    assert.equal(library.attachments.length, 1);
    assert.equal(library.attachments[0].rawPath, "storage:paper.pdf");
    assert.equal(library.collections[0].name, "Robotics");
});

test("searchOfflineFulltext maps FTS rowid to the parent item", (t) => {
    if (!hasFts5()) {
        t.skip("node:sqlite build has no FTS5");
        return;
    }
    const dir = makeZoteroFixture(true);
    const hits = searchOfflineFulltext(dir, "robot", 10);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].key, "PARENT01");
    assert.equal(hits[0].title, "A study of robots");
    assert.equal(searchOfflineFulltext(dir, "").length, 0);
});

test("missing database reports unavailable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-zotero-empty-"));
    assert.equal(offlineSqliteStatus(dir).available, false);
    assert.equal(readOfflineLibrary(dir), null);
    assert.deepEqual(searchOfflineFulltext(dir, "robot", 5), []);
});
