# 安装与快速上手

[English](getting-started.en.md) · [目录](README.md)

## 安装

1. 按 SFMC 现有模块安装流程安装本包。模块入口为 `sapi/src/index.ts`，manifest 的模块 ID 是 `land`。本仓库的 `build` 只做类型检查，不单独产出行为包；由平台构建和加载 SAPI。
2. 安装并启用 `economy`、`activity-log`，确认数据库服务可用。即使将圈地价格和维护费设为零，manifest 仍要求这两个模块。
3. 将 [configs-default/land.json](../configs-default/land.json) 中的新字段合并到服务器的 `configs/land.json`，不要直接覆盖已有服主配置。旧租赁配置缺项会回退到新默认值。
4. 重新加载模块或重启服务器，使配置重新进入 `init()`；本模块没有配置热更新监听。
5. 检查日志 `ready lands=<数量> claims=<数量>`，执行 `/c:land help`。初始化未完成时破坏、放置等操作会被拒绝，伤害和爆炸被取消。

不要将安装成功等同于保护验证完成。按[验证指南](verify.md)用领主与访客账号实测。

## 第一块领地

在希望占领的区块内执行：

```text
/c:land create 家园
/c:land info 家园
/c:land deposit 家园 100
```

创建占领脚下 16×16 区块的完整垂直范围，并将当前位置设为出生点。默认创建费用 50 从玩家账户扣除。单区块默认每日维护费 `10 + 2 × 1 = 12`，由 `land:<领地ID>` 银行支付；创建不会自动为银行充值。

扩张时移动到另一个未占领区块：

```text
/c:land claim 家园
/c:land map
/c:land border 家园
/c:land border_stop
```

扩张不要求与原区块相邻，可跨维度。默认 1 级最多 16 块，包含创建时的第一块。

## 加入成员

```text
/c:land invite 家园 Alice
```

Alice 执行：

```text
/c:land accept 家园
```

邀请默认分配“成员”模板；接受前没有领地级成员权限。目标可以是在线名字、稳定玩家 ID，或系统已记录的离线身份。首次出现且从未记录的离线名字无法解析。

移除成员需显式确认：

```text
/c:land kick 家园 Alice confirm
```

## 创建三维区域

保持同一维度，分别站在选区两角执行：

```text
/c:land area_pos1
/c:land area_pos2
/c:land area_create 家园 仓库
/c:land area_info 家园 仓库
```

选点是玩家当前坐标，不是准星指向的方块。两端方块都包含，存储转换为 `[min,max)`。区域碰到的所有水平区块都必须属于家园。详见[区域规则](areas.md)。

为 Alice 仅在仓库分配不同角色：

```text
/c:land role_create 家园 仓管
/c:land role_grant 家园 仓管 container.open
/c:land area_member 家园 仓库 Alice 仓管
```

区域角色整体替换领地角色，不会自动合并原“成员”的建造权限。

## 释放与删除

```text
/c:land unclaim 家园 confirm
/c:land delete 家园 confirm
```

释放的是脚下区块；最后一块和仍被 Area 使用的区块不能释放。默认不退款。删除要求银行余额为零，没有有效租约、开放挂牌和未完成交易；失败原因应先处理，不要直接删除数据库行。转让会把原领主设为领地管理员，不会自动解除他的权限。
