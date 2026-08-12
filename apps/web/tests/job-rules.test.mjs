import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyMatch,
  isUnderServedJob,
  toPublicJobView,
} from "../lib/job-rules.mjs";

test("沉睡职位包含第 7 天和第 30 天边界", () => {
  assert.equal(
    isUnderServedJob({ ageDays: 7, status: "active", recommendationCount: 0 }),
    true,
  );
  assert.equal(
    isUnderServedJob({ ageDays: 30, status: "active", recommendationCount: 0 }),
    true,
  );
});

test("排除时间窗外、无效或已有推荐的职位", () => {
  assert.equal(
    isUnderServedJob({ ageDays: 6, status: "active", recommendationCount: 0 }),
    false,
  );
  assert.equal(
    isUnderServedJob({ ageDays: 31, status: "active", recommendationCount: 0 }),
    false,
  );
  assert.equal(
    isUnderServedJob({ ageDays: 12, status: "closed", recommendationCount: 0 }),
    false,
  );
  assert.equal(
    isUnderServedJob({ ageDays: 12, status: "active", recommendationCount: 1 }),
    false,
  );
});

test("匹配分层遵守 85 和 75 分边界", () => {
  assert.equal(classifyMatch(85), "high");
  assert.equal(classifyMatch(84), "medium");
  assert.equal(classifyMatch(75), "medium");
  assert.equal(classifyMatch(74), "low");
});

test("候选人落地页投影隐藏公司与详细地址", () => {
  const publicJob = toPublicJobView({
    title: "资深前端工程师",
    companyName: "示例科技有限公司",
    companyAlias: "示例科技",
    city: "上海",
    detailedLocation: "浦东新区世纪大道 100 号",
    salaryMin: 30,
    salaryMax: 45,
  });

  assert.deepEqual(publicJob, {
    title: "资深前端工程师",
    city: "上海",
    salaryRange: "30–45",
    companyLabel: "某科技企业",
  });
  assert.equal("companyName" in publicJob, false);
  assert.equal("detailedLocation" in publicJob, false);
  // 序列化后也不得残留真实公司名或详细地址（脱敏守卫作用于投影内容，而非仅字段裁剪）
  const serialized = JSON.stringify(publicJob);
  assert.doesNotMatch(serialized, /示例科技有限公司/);
  assert.doesNotMatch(serialized, /浦东新区世纪大道/);
});
