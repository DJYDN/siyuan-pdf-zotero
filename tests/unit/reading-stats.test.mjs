import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_DONE_RATIO,
    MIN_READING_SECONDS,
    annotationDensity,
    createReadingStat,
    dailyTotals,
    dayKey,
    formatDuration,
    furthestPage,
    normalizeReadingStat,
    progressOf,
    recordReading,
    relativeTime,
    statusOf,
} from "../../.test-build/reading-stats.mjs";

const at = new Date("2026-11-22T10:00:00").getTime();

test("recordReading accumulates dwell, days, visited and totals", () => {
    let stat = createReadingStat(10, at);
    stat = recordReading(stat, {page: 3, pages: 10, seconds: 10, at});
    stat = recordReading(stat, {page: 3, pages: 10, seconds: 10, at});
    stat = recordReading(stat, {page: 5, pages: 10, seconds: 15, at});
    assert.equal(stat.dwell["3"], 20);
    assert.equal(stat.dwell["5"], 15);
    assert.equal(stat.totalSeconds, 35);
    assert.deepEqual(stat.visited, [3, 5]);
    assert.equal(stat.lastPage, 5);
    assert.equal(stat.pages, 10);
    assert.equal(stat.days[dayKey(at)], 35);
});

test("recordReading ignores invalid ticks", () => {
    const stat = createReadingStat(5, at);
    assert.equal(recordReading(stat, {page: 0, seconds: 10, at}), stat);
    assert.equal(recordReading(stat, {page: 2, seconds: 0, at}), stat);
    assert.equal(recordReading(stat, {page: Number.NaN, seconds: 10, at}), stat);
});

test("progressOf counts distinct visited pages", () => {
    let stat = createReadingStat(4, at);
    assert.equal(progressOf(stat), 0);
    stat = recordReading(stat, {page: 1, pages: 4, seconds: 10, at});
    assert.equal(progressOf(stat), 0.25);
    stat = recordReading(stat, {page: 1, pages: 4, seconds: 10, at});
    assert.equal(progressOf(stat), 0.25, "re-reading a page must not inflate progress");
    stat = recordReading(stat, {page: 4, pages: 4, seconds: 10, at});
    assert.equal(progressOf(stat), 0.5);
    assert.equal(progressOf(undefined), 0);
});

test("statusOf derives unread/reading/done and honours manual overrides", () => {
    let stat = createReadingStat(10, at);
    assert.equal(statusOf(stat), "unread");

    stat = recordReading(stat, {page: 1, pages: 10, seconds: MIN_READING_SECONDS - 1, at});
    assert.equal(statusOf(stat), "unread", "less than a minute of reading is still unread");

    stat = recordReading(stat, {page: 1, pages: 10, seconds: 10, at});
    assert.equal(statusOf(stat), "reading");

    stat = recordReading(stat, {page: 1, pages: 10, seconds: 10, at, });
    for (let page = 2; page <= 10; page += 1) {
        stat = recordReading(stat, {page, pages: 10, seconds: 10, at});
    }
    assert.equal(progressOf(stat), 1);
    assert.equal(statusOf(stat), "done");
    assert.equal(DEFAULT_DONE_RATIO, 0.95);

    assert.equal(statusOf({...stat, manualStatus: "reading"}), "reading");
    assert.equal(statusOf({...createReadingStat(10, at), manualStatus: "done"}), "done");
});

test("statusOf respects a custom done ratio", () => {
    let stat = createReadingStat(10, at);
    stat = recordReading(stat, {page: 1, pages: 10, seconds: 120, at});
    stat = recordReading(stat, {page: 2, pages: 10, seconds: 120, at});
    assert.equal(statusOf(stat, {doneRatio: 0.2}), "done");
    assert.equal(statusOf(stat, {doneRatio: 0.9}), "reading");
});

test("annotationDensity buckets annotations by page", () => {
    const annotations = [
        {page: 1}, {page: 1}, {page: 3}, {page: 99}, {page: 0},
    ];
    assert.deepEqual(annotationDensity(annotations, 3), [2, 0, 1]);
    assert.deepEqual(annotationDensity([], 2), [0, 0]);
});

test("formatDuration and relativeTime are human readable", () => {
    assert.equal(formatDuration(0), "0 秒");
    assert.equal(formatDuration(59), "59 秒");
    assert.equal(formatDuration(60), "1 分钟");
    assert.equal(formatDuration(3600), "1 小时");
    assert.equal(formatDuration(5400), "1 小时 30 分");

    assert.equal(relativeTime(0), "");
    assert.equal(relativeTime(at, at + 30_000), "刚刚");
    assert.equal(relativeTime(at, at + 5 * 60_000), "5 分钟前");
    assert.equal(relativeTime(at, at + 3 * 3_600_000), "3 小时前");
    assert.equal(relativeTime(at, at + 2 * 86_400_000), "2 天前");
});

test("normalizeReadingStat repairs legacy or corrupted payloads", () => {
    const stat = normalizeReadingStat({
        pages: "12",
        dwell: {"2": 30, bad: 10, "-1": 5, "0": 3},
        visited: [2, 2, "3", 0, null],
        lastPage: 0,
        days: {"2026-11-20": 40, nope: 10},
        manualStatus: "done",
    });
    assert.equal(stat.pages, 12);
    assert.deepEqual(Object.keys(stat.dwell), ["2"]);
    assert.deepEqual(stat.visited, [2, 3]);
    assert.equal(stat.lastPage, 3);
    assert.equal(stat.totalSeconds, 30);
    assert.deepEqual(stat.days, {"2026-11-20": 40});
    assert.equal(stat.manualStatus, "done");
});

test("furthestPage and dailyTotals aggregate across PDFs", () => {
    let a = createReadingStat(20, at);
    a = recordReading(a, {page: 7, pages: 20, seconds: 60, at});
    let b = createReadingStat(5, at);
    b = recordReading(b, {page: 2, pages: 5, seconds: 30, at});
    assert.equal(furthestPage(a), 7);
    assert.equal(furthestPage(undefined), 1);
    assert.deepEqual(dailyTotals([a, b, undefined]), [{day: dayKey(at), seconds: 90}]);
});
