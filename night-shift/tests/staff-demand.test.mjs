import { rankSkuByDemand } from '../src/staff.mjs';

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } }

const skus = [{ id: 'drink' }, { id: 'noodle' }, { id: 'bento' }, { id: 'odesmashed' }];

console.log('需求驱动补货排序测试');

// 1) 无流水 → 退化为"货架最少优先"，与旧行为一致（给全部 SKU 明确存量）
{
  const out = rankSkuByDemand(skus, {
    shelfQty: { drink: 8, noodle: 2, bento: 5, odesmashed: 7 },
  });
  ok('无流水时货架最少(noodle)排第一', out[0].id === 'noodle');
}

// 2) 有缺货流失 → 流失最多的排第一（即便它货架存量不是最少）
{
  const out = rankSkuByDemand(skus, {
    missed: { bento: 6, drink: 1 }, sold: {}, shelfQty: { bento: 8, drink: 0, noodle: 0 },
  });
  ok('缺货流失最多的 bento 排第一', out[0].id === 'bento');
}

// 3) 缺货流失权重高于销量：missed=2 → 8 分，压过 sold=6 → 6 分
{
  const out = rankSkuByDemand(skus, {
    missed: { noodle: 2 }, sold: { drink: 6 }, shelfQty: {},
  });
  ok('missed 权重(×4)压过纯销量', out[0].id === 'noodle');
}

// 4) 无缺货、有销量 → 销量高的优先
{
  const out = rankSkuByDemand(skus, { sold: { drink: 7, bento: 3 }, shelfQty: {} });
  ok('销量最高的 drink 排第一', out[0].id === 'drink');
}

// 5) 不改入参（纯函数）
{
  const before = skus.map((s) => s.id).join(',');
  rankSkuByDemand(skus, { missed: { bento: 9 } });
  ok('不修改输入数组', skus.map((s) => s.id).join(',') === before);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
