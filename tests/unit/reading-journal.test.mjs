import test from "node:test";
import assert from "node:assert/strict";
import {
    applyJournalMap,
    formatJournalTags,
    normalizeJournalName,
    parseJournalMap,
} from "../../.test-build/reading-journal.mjs";

test("normalizeJournalName collapses whitespace", () => {
    assert.equal(normalizeJournalName("  Nature   Communications "), "Nature Communications");
    assert.equal(normalizeJournalName(""), "");
});

test("parseJournalMap supports literal and regex rules", () => {
    const rules = parseJournalMap("SCIIF(5)=IF(5), /^SCI(\\d)$/=Q$1, SCI=");
    assert.equal(rules.length, 3);
    assert.equal(applyJournalMap("SCIIF", "5", rules), "IF(5)");
    assert.equal(applyJournalMap("SCI", "1", rules), "Q1");
    assert.equal(applyJournalMap("SCI", "", rules), "");
});

test("applyJournalMap returns null when no rule matches", () => {
    const rules = parseJournalMap("");
    assert.equal(applyJournalMap("sciUp", "1区", rules), null);
    assert.equal(applyJournalMap("北大核心", "", rules), null);
});

test("invalid regex rules are ignored instead of throwing", () => {
    const rules = parseJournalMap("/[unclosed/=X, CCF=A");
    assert.equal(rules.length, 1);
    assert.equal(applyJournalMap("CCF", "A", rules), "A");
});

test("formatJournalTags only shows configured fields, in order", () => {
    const fields = {sci: "Q1", sciif: "8.2", ccf: "A", eii: "EI", swufe: "A+"};
    const text = formatJournalTags(fields, "SCIIF=IF, SCI=", "sci,sciif,eii");
    assert.equal(text, "IF 8.2 · EI");
    assert.equal(formatJournalTags(fields, "", "ccf"), "CCF A");
    assert.equal(formatJournalTags(undefined, "", "sci"), "");
});

test("formatJournalTags caps unconfigured output at four fields", () => {
    const fields = {a: "1", b: "2", c: "3", d: "4", e: "5"};
    assert.equal(formatJournalTags(fields, "", "").split(" · ").length, 4);
});

test("formatJournalTags handles Chinese-journal membership fields", () => {
    const fields = {cssci: "CSSCI", pku: "1", zhongguokejihexin: "中国科技核心期刊"};
    assert.equal(formatJournalTags(fields, "", "cssci,pku"), "CSSCI · 北大核心");
    assert.equal(formatJournalTags(fields, "", "zhongguokejihexin"), "中国科技核心期刊");
});
