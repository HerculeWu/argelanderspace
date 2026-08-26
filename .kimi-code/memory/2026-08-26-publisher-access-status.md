# 出版商可达性实测（2026-08-26）

对获取管线全部上游做了一次活体探测（脚本曾存于 `/tmp/probe_bibgraph.py`，可能已清）。结论：

## 期刊官网 HTML/PDF：全部不可自动获取

| 站 | 状态 | 墙 |
|---|---|---|
| aanda.org（A&A/EDP） | 全站 403，UA 无关 | **DataDome**（captcha-delivery.com） |
| academic.oup.com（MNRAS/OUP） | 403 | **Cloudflare** "Just a moment" |
| Wiley 老 MNRAS DOI（10.1046/10.1111） | 301 → academic.oup.com → 403 | Cloudflare |
| iopscience.iop.org（AAS/IOP、老 IOP DOI） | 人机验证页 | **Radware** perfdrive |
| link.aps.org / journals.aps.org | 403 | **Cloudflare** |

⚠️ 代码与现实脱节：`acquire/planner.py` 里 EDP/A&A 仍是 READY、`oup` 适配器注册着，但实际全抓不了。**新 session 不要再去试这些站，也不要相信 plan 输出的 journal_html READY。** TS 重构时这些适配器移植为待命能力，README 需写明现状。

## 可用

- **arXiv 全线正常**：e-print（LaTeX 管线）、/pdf、/abs。端到端实测通过（2501.17225：39 节/76 参考/引用解析 123/124）。这是当前**唯一全自动**的摄入源。
- **ADS 扫描件**（articles.adsabs.harvard.edu）：半可用，老文章能下但偶发 504。
- **Crossref / OpenAlex API**：正常。
- **MinerU**：站点可达、key 有效（未烧额度实测提取）。

## keys（2026-08-26 全部实测有效）

- `MINERU_API_KEY`：`~/.zshrc` 导出，代码读 env（`config.py`）
- ADS token：`~/.ads/dev_key`（曾过期，用户已更新，Solr API 200）；代码先读 `$ADS_DEV_KEY` 再读文件
- `OPENALEX_API_KEY`：`~/.zshrc` 导出，key 有效；**但 `library/sources/openalex.py` 只读 `OPENALEX_MAILTO`，不用这个 key**——TS 版记得带上 `api_key` 参数
