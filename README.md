# 顺风车出行板

可发布到 GitHub Pages、使用 Supabase 共享数据的司机出行信息页面。

## 功能

- 所有访问者共享查看同一份行程
- 登记司机称呼、出行日期与时间、出发地、途经地点、终点、可载人数、剩余人数和联系方式
- 按出行日期从新到旧排列，并实时同步其他访问者的新增和修改
- 只有行程发布者可以调整剩余座位或删除自己的行程
- 数据库每小时清理创建超过 7 天的记录
- 支持导入和导出 `.properties` 备份
- 支持将旧版本的浏览器本地记录迁移到共享列表
- 适配电脑和手机屏幕

## 1. 创建 Supabase 项目

1. 登录 [Supabase](https://supabase.com/) 并创建一个项目。
2. 打开 **Authentication > Providers > Anonymous Sign-Ins**，启用匿名登录。
3. 打开 **SQL Editor**，复制并运行 [`supabase/schema.sql`](supabase/schema.sql) 的全部内容。

数据库脚本会创建 `trips` 表、访问权限、实时同步配置，以及每小时运行一次的过期记录清理任务。

如果项目之前已经运行过旧版脚本，也请重新运行当前脚本。它会为现有表补充路线字段，不会删除已有行程；旧记录的路线会显示为“待补充”。

## 2. 填写网站配置

在 Supabase 的 **Project Settings > API** 中找到：

- Project URL
- Publishable key，旧项目中可能显示为 `anon public` key

把它们填入 [`config.js`](config.js)：

```js
window.CARPOOL_CONFIG = Object.freeze({
  supabaseUrl: "https://你的项目编号.supabase.co",
  supabaseAnonKey: "你的 Publishable 或 anon public key",
});
```

Publishable/anon key 原本就用于网页客户端，可以随网站公开。不要在此文件中填写 `service_role` 密钥。

## 3. 本地检查

由于共享功能需要 HTTP 环境，请在项目目录运行：

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

然后访问 `http://127.0.0.1:4173`。

## 4. 发布到 GitHub Pages

1. 将项目文件推送到 GitHub 仓库的默认分支。
2. 打开仓库的 **Settings > Pages**。
3. 在 **Build and deployment** 中选择 **Deploy from a branch**。
4. 选择默认分支和根目录 `/ (root)`，然后保存。

部署完成后，任何人访问该 Pages 地址都会读取同一个 Supabase 数据库。

## 权限说明

网站会为每个浏览器创建一个 Supabase 匿名用户。所有匿名用户可以查看未过期行程，但只能修改和删除自己发布的行程。如果清除浏览器站点数据或换用另一台设备，仍能看到原行程，但会失去对原行程的编辑身份。
