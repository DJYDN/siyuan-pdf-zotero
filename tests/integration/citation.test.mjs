import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import {zoteroItemToCsl} from "../../.test-build/citation-mapper.mjs";

const require = createRequire(import.meta.url);
const CSL = require("citeproc");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const styleRoot = path.join(root, "styles");

const item = zoteroItemToCsl({
    key: "K3WY8RWM",
    itemType: "journalArticle",
    title: "Modeling elastoviscoplastic materials using physics-informed neural networks",
    date: "2026",
    volume: "22",
    issue: "22",
    pages: "3946-3958",
    publicationTitle: "Soft Matter",
    DOI: "10.1039/D6SM00198J",
    creators: [
        {firstName: "Babak", lastName: "Valipour Goodarzi", creatorType: "author"},
        {firstName: "Reza", lastName: "Foudazi", creatorType: "author"},
    ],
}, 0);

function engineFor(styleFile, lang, items = [item]) {
    const style = fs.readFileSync(path.join(styleRoot, styleFile), "utf8");
    const locale = fs.readFileSync(path.join(styleRoot, lang === "zh-CN" ? "locales-zh-CN.xml" : "locales-en-US.xml"), "utf8");
    const byId = new Map(items.map(entry => [entry.id, entry]));
    const sys = {
        retrieveLocale: () => locale,
        retrieveItem: id => byId.get(id) || {id, type: "article", title: id},
    };
    return new CSL.Engine(sys, style, lang);
}

for (const [name, file, lang, expected] of [
    ["GB/T 7714", "gb-t-7714-2015-numeric.csl", "zh-CN", "VALIPOUR GOODARZI B"],
    ["APA", "apa.csl", "en-US", "Valipour Goodarzi"],
    ["IEEE", "ieee.csl", "en-US", "Soft Matter"],
]) {
    test(`citeproc ${name} produces citation and bibliography`, () => {
        const engine = engineFor(file, lang);
        engine.updateItems([item.id]);
        const citation = engine.makeCitationCluster([{id: item.id}]);
        const bibliography = engine.makeBibliography();
        assert.ok(String(citation).length > 0);
        assert.ok(bibliography?.[1]?.length === 1);
        assert.ok(String(bibliography[1][0]).includes(expected));
    });
}

test("citeproc supports locator, prefix, suffix and suppress-author", () => {
    const engine = engineFor("apa.csl", "en-US");
    engine.updateItems([item.id]);
    const citation = String(engine.makeCitationCluster([{
        id: item.id,
        locator: "12",
        prefix: "see",
        suffix: "for details",
        "suppress-author": false,
    }]));
    assert.ok(citation.includes("see"));
    assert.ok(citation.includes("12"));
    assert.ok(citation.includes("for details"));
    const suppressed = String(engine.makeCitationCluster([{id: item.id, "suppress-author": true}]));
    assert.ok(!suppressed.includes("Valipour"));
});

test("citeproc formats a multi-item citation cluster", () => {
    const second = {...item, id: "0:XCGDD3S3", title: "Second paper", author: [{family: "Li", given: "Y."}]};
    const engine = engineFor("apa.csl", "en-US", [item, second]);
    engine.updateItems([item.id, second.id]);
    const citation = String(engine.makeCitationCluster([{id: item.id}, {id: second.id}]));
    assert.ok(citation.includes("Valipour Goodarzi"));
    assert.ok(citation.includes("Li"));
});

