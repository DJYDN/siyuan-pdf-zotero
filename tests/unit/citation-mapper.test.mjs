import test from "node:test";
import assert from "node:assert/strict";
import {zoteroItemToCsl} from "../../.test-build/citation-mapper.mjs";

const sample = {
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
};

test("zoteroItemToCsl maps journal article fields", () => {
    const csl = zoteroItemToCsl(sample, 0);
    assert.equal(csl.id, "0:K3WY8RWM");
    assert.equal(csl.type, "article-journal");
    assert.equal(csl.title, sample.title);
    assert.equal(csl["container-title"], "Soft Matter");
    assert.equal(csl.DOI, "10.1039/D6SM00198J");
    assert.equal(csl.issued["date-parts"][0][0], 2026);
    assert.deepEqual(csl.author[0], {family: "Valipour Goodarzi", given: "Babak"});
});

test("zoteroItemToCsl handles literal creator names and missing dates", () => {
    const csl = zoteroItemToCsl({
        key: "X",
        itemType: "report",
        title: "A report",
        creators: [{name: "World Health Organization", creatorType: "author"}],
    }, 3);
    assert.equal(csl.id, "3:X");
    assert.equal(csl.type, "report");
    assert.deepEqual(csl.author, [{literal: "World Health Organization"}]);
    assert.equal(csl.issued, undefined);
});
