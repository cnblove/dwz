-- 用户组资源配额
--
-- 背景：用户组此前只管「能看到哪些页面」（nav_list），管不了「能用多少」。
-- 运营场景里这两件事必须分开：一个成员该看得到活码页，但不该一天建 200 个群码
-- （群码建多了没人维护，落到用户那里就是失效的码）。参考项目的运营同学提的
-- 正是这条：「限制成员能创建多少群码，要不然无脑创建很容易死」。
--
-- 设计说明：
--   1. 配额挂在「用户组」而不是「账号」上。同一类人要限的量是一样的，
--      逐个账号配一遍既费事又会配漏；组改了，组里所有人一起生效。
--   2. 每类资源一列，NULL = 不限额。沿用模块内的既有口径：**用 NULL 表达「不限」**，
--      而不是让人填一个「大到像没限制」的数字（两者在界面上长得一样，
--      但 NULL 能被代码可靠地区分出来）。
--   3. 默认全部 NULL —— 新建的用户组行为与改动前完全一致，不开限流。
--   4. 只加列不改表：user_groups 没有任何外键指向它，
--      但加列本身也不需要重建表，ALTER TABLE ADD COLUMN 即可。
--
-- 统计口径跟着资源走（见 lib/quota.js 的说明）：
--   短链 → short_links  活码 → codes  渠道码 → channels
--   子码 → 统计用户名下所有活码的子码总数
--   素材 → assets

ALTER TABLE user_groups ADD COLUMN quota_short_links INTEGER;
ALTER TABLE user_groups ADD COLUMN quota_codes       INTEGER;
ALTER TABLE user_groups ADD COLUMN quota_qrcodes     INTEGER;
ALTER TABLE user_groups ADD COLUMN quota_channels    INTEGER;
ALTER TABLE user_groups ADD COLUMN quota_assets      INTEGER;
