import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_GALLERY_SETTINGS,
    GALLERY_GROUP_OPTIONS,
    galleryFields,
    itemTypeLabel,
    normalizeGallerySettings,
    statusFromLabel,
    statusLabel,
} from "../../.test-build/matrix-gallery.mjs";

test("gallery settings normalise an empty payload to defaults", () => {
    assert.deepEqual(normalizeGallerySettings(undefined), DEFAULT_GALLERY_SETTINGS);
    assert.deepEqual(normalizeGallerySettings(null), DEFAULT_GALLERY_SETTINGS);
});

test("gallery settings merge partial persisted values", () => {
    const merged = normalizeGallerySettings({mode: "annotations", layout: "horizontal", sortDirection: "asc", covers: false, scope: "project"});
    assert.equal(merged.mode, "annotations");
    assert.equal(merged.layout, "horizontal");
    assert.equal(merged.sortDirection, "asc");
    assert.equal(merged.covers, false);
    assert.equal(merged.scope, "project");
    assert.deepEqual(merged.fields, DEFAULT_GALLERY_SETTINGS.fields);
});

test("gallery settings reject unknown enum values", () => {
    const merged = normalizeGallerySettings({mode: "bogus", layout: "x", scope: "y", groupBy: "nope", sortDirection: "up"});
    assert.equal(merged.mode, "items");
    assert.equal(merged.layout, "vertical");
    assert.equal(merged.scope, "library");
    assert.equal(merged.groupBy, "itemType");
    assert.equal(merged.sortDirection, "desc");
});

test("gallery settings validate fields and group presets", () => {
    assert.deepEqual(normalizeGallerySettings({fields: ["journal", 3, null, "readStatus"]}).fields, ["journal", "readStatus"]);
    assert.equal(normalizeGallerySettings({groupBy: "readStatus"}).groupBy, "readStatus");
    assert.ok(GALLERY_GROUP_OPTIONS.some(option => option.value === "readStatus"));
});

test("galleryFields resolves ids and drops stale ones", () => {
    const project = {
        columns: [
            {id: "title", name: "标题", type: "text", visible: true, system: true, source: "zotero"},
            {id: "journal", name: "期刊标签", type: "text", visible: true, system: true, source: "zotero"},
            {id: "rating", name: "相关性", type: "rating", visible: true, system: false, source: "research"},
        ],
    };
    const fields = galleryFields(project, {...DEFAULT_GALLERY_SETTINGS, fields: ["journal", "missing", "rating"]});
    assert.deepEqual(fields.map(column => column.id), ["journal", "rating"]);
});

test("reading status labels map both ways", () => {
    assert.equal(statusFromLabel("未读"), "unread");
    assert.equal(statusFromLabel("在读"), "reading");
    assert.equal(statusFromLabel("已读"), "done");
    assert.equal(statusFromLabel("东西"), undefined);
    assert.equal(statusLabel("done"), "已读");
    assert.equal(statusLabel(undefined), "");
});

test("gallery groups by item type by default and knows Chinese labels", () => {
    assert.equal(DEFAULT_GALLERY_SETTINGS.groupBy, "itemType");
    assert.equal(normalizeGallerySettings({}).scope, "library");
    assert.equal(normalizeGallerySettings({}).covers, true);
    assert.equal(itemTypeLabel("journalArticle"), "期刊文章");
    assert.equal(itemTypeLabel("conferencePaper"), "会议论文");
    assert.equal(itemTypeLabel("thesis"), "学位论文");
    assert.equal(itemTypeLabel("unknownType"), "unknownType");
    assert.equal(itemTypeLabel(""), "其他");
});
