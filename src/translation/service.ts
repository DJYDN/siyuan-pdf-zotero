import type {TranslationServiceConfig, TranslationServiceType} from "../types";
import {requireNode} from "../runtime";

export interface TranslationResult {
    text: string;
    service: string;
}

const TARGET_LABELS: Record<string, string> = {
    "zh-CN": "简体中文",
    "zh-TW": "繁體中文",
    en: "English",
    ja: "日本語",
    ko: "한국어",
    de: "Deutsch",
    fr: "Français",
    es: "Español",
    ru: "Русский",
};

export const TRANSLATION_TARGETS = Object.keys(TARGET_LABELS);

function targetLabel(code: string): string {
    return TARGET_LABELS[code] || code || "简体中文";
}

function codeFor(service: TranslationServiceType, target: string): string {
    if (service === "deepl") {
        return target === "zh-TW" ? "ZH-HANT" : target === "zh-CN" ? "ZH-HANS" : target.toUpperCase();
    }
    if (service === "google") {
        return target;
    }
    if (service === "bing") {
        return target === "zh-CN" ? "zh-Hans" : target === "zh-TW" ? "zh-Hant" : target;
    }
    if (service === "mymemory") {
        return target;
    }
    if (service === "baidu" || service === "tencent" || service === "aliyun") {
        return target === "zh-TW" ? "cht" : target.startsWith("zh") ? "zh" : target;
    }
    if (service === "youdao") {
        return target === "zh-TW" ? "zh-CHT" : target.startsWith("zh") ? "zh-CHS" : target;
    }
    if (service === "azure") {
        return target === "zh-CN" ? "zh-Hans" : target === "zh-TW" ? "zh-Hant" : target;
    }
    if (service === "caiyun") {
        return target.startsWith("zh") ? "auto2zh" : "auto2en";
    }
    return target;
}

function splitSecret(value: string): string[] {
    return String(value || "").split("#");
}

function hash(algorithm: string, value: string): string {
    const crypto = requireNode("crypto");
    return crypto.createHash(algorithm).update(value, "utf8").digest("hex");
}

function hmac(algorithm: string, key: string | Buffer, value: string, encoding: "hex" | "base64" = "hex"): string {
    const crypto = requireNode("crypto");
    return crypto.createHmac(algorithm, key).update(value, "utf8").digest(encoding);
}

function rfc3986(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function httpRequest(
    urlValue: string,
    options: {method?: string; headers?: Record<string, string>; body?: string; timeout?: number} = {},
    redirects = 0,
): Promise<{status: number; text: string}> {
    const url = new URL(urlValue);
    const transport = requireNode(url.protocol === "https:" ? "https" : "http");
    if (!transport?.request) {
        return Promise.reject(new Error("当前运行环境没有 Node HTTP 能力"));
    }
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {...(options.headers || {})};
        if (options.body && !Object.keys(headers).some(key => key.toLowerCase() === "content-length")) {
            headers["Content-Length"] = String(Buffer.byteLength(options.body));
        }
        const request = transport.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: `${url.pathname}${url.search}`,
            method: options.method || "GET",
            headers,
        }, (response: any) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => {
                const status = response.statusCode || 0;
                const location = response.headers.location;
                if ([301, 302, 303, 307, 308].includes(status) && location && redirects < 5) {
                    const nextUrl = new URL(location, url).href;
                    const nextOptions: typeof options = {...options, headers: {...(options.headers || {})}};
                    if (status === 301 || status === 302 || status === 303) {
                        nextOptions.method = "GET";
                        delete nextOptions.body;
                        delete nextOptions.headers["Content-Type"];
                        delete nextOptions.headers["Content-Length"];
                    }
                    resolve(httpRequest(nextUrl, nextOptions, redirects + 1));
                    return;
                }
                resolve({
                    status,
                    text: Buffer.concat(chunks).toString("utf8"),
                });
            });
        });
        request.setTimeout(options.timeout || 30_000, () => request.destroy(new Error("翻译请求超时")));
        request.on("error", reject);
        if (options.body) request.write(options.body);
        request.end();
    });
}

async function postForm(url: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<any> {
    const response = await httpRequest(url, {
        method: "POST",
        headers: {"Content-Type": "application/x-www-form-urlencoded", ...headers},
        body: new URLSearchParams(form).toString(),
    });
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}: ${response.text.slice(0, 300)}`);
    }
    return JSON.parse(response.text);
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
    const response = await httpRequest(url, {headers});
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}: ${response.text.slice(0, 300)}`);
    }
    return JSON.parse(response.text);
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
    const response = await httpRequest(url, {
        method: "POST",
        headers: {"Content-Type": "application/json", ...headers},
        body: JSON.stringify(body),
    });
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}: ${response.text.slice(0, 300)}`);
    }
    return JSON.parse(response.text);
}

async function translateOpenAICompatible(config: TranslationServiceConfig, text: string, target: string): Promise<string> {
    if (!config.baseURL.trim()) throw new Error("OpenAI 兼容服务缺少 Base URL");
    if (!config.apiKey.trim()) throw new Error("OpenAI 兼容服务缺少 API Key");
    const data = await postJson(
        `${config.baseURL.replace(/\/+$/, "")}/chat/completions`,
        {
            model: config.model || "gpt-4o-mini",
            temperature: 0,
            messages: [
                {role: "system", content: `You are a precise translator. Translate into ${targetLabel(target)}. Return only the translated text.`},
                {role: "user", content: text},
            ],
        },
        {Authorization: `Bearer ${config.apiKey}`},
    );
    const result = data?.choices?.[0]?.message?.content;
    if (!result) throw new Error("OpenAI 兼容服务没有返回译文");
    return String(result).trim();
}

async function translateSiyuanAI(config: TranslationServiceConfig, text: string, target: string): Promise<string> {
    const ai = (window as any).siyuan?.config?.ai || {};
    const providers = (Array.isArray(ai.providers) ? ai.providers : []).filter((item: any) => item && item.enabled !== false);
    if (!providers.length) throw new Error("思源尚未配置 AI provider");
    const selectedId = config.model || ai.agent?.modelId || ai.editing?.modelId || "";
    let provider: any;
    let model: string = "";
    for (const candidate of providers) {
        for (const item of candidate.models || []) {
            const id = typeof item === "string" ? item : String(item?.id || item?.name || "");
            const name = typeof item === "string" ? item : String(item?.name || item?.id || "");
            if (selectedId && (id === selectedId || name === selectedId)) {
                provider = candidate;
                model = name;
                break;
            }
        }
        if (provider) break;
    }
    if (!provider) {
        provider = providers[0];
    }
    if (!model) {
        const first = (provider.models || [])[0];
        model = typeof first === "string" ? first : String(first?.name || first?.id || "");
    }
    if (!model) throw new Error("思源 AI provider 没有可用模型");
    if (provider.authType === "chatgpt" && !provider.apiKey) {
        throw new Error("ChatGPT 账号登录型 provider 不能直接作为翻译 API 使用");
    }
    const headers: Record<string, string> = {"Content-Type": "application/json"};
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    if (provider.protocol === "anthropic") {
        headers["x-api-key"] = provider.apiKey;
        headers["anthropic-version"] = "2023-06-01";
        const data = await postJson(`${provider.baseURL.replace(/\/+$/, "")}/messages`, {
            model,
            max_tokens: 1500,
            temperature: 0,
            messages: [{role: "user", content: `Translate into ${targetLabel(target)}. Return only the translation:\n\n${text}`}],
        }, headers);
        return String((data.content || []).map((item: any) => item?.text || "").join("\n")).trim();
    }
    const data = await postJson(`${provider.baseURL.replace(/\/+$/, "")}/chat/completions`, {
        model,
        temperature: 0,
        messages: [
            {role: "system", content: `You are a precise translator. Translate into ${targetLabel(target)}. Return only the translated text.`},
            {role: "user", content: text},
        ],
    }, headers);
    return String(data?.choices?.[0]?.message?.content || "").trim();
}

async function translateDeepL(config: TranslationServiceConfig, text: string, target: string): Promise<string> {
    if (!config.apiKey.trim()) throw new Error("DeepL 缺少 API Key");
    const data = await postForm(
        `${config.baseURL.replace(/\/+$/, "")}/translate`,
        {text, target_lang: codeFor("deepl", target)},
        {Authorization: `DeepL-Auth-Key ${config.apiKey}`},
    );
    const result = data?.translations?.[0]?.text;
    if (!result) throw new Error("DeepL 没有返回译文");
    return String(result).trim();
}

async function translateGoogle(config: TranslationServiceConfig, text: string, target: string): Promise<string> {
    const url = new URL(`${config.baseURL.replace(/\/+$/, "")}/translate_a/single`);
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", "auto");
    url.searchParams.set("tl", codeFor("google", target));
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", text);
    if (config.apiKey.trim()) url.searchParams.set("key", config.apiKey);
    const data = await getJson(url.href);
    const result = (data?.[0] || []).map((item: any) => item?.[0] || "").join("");
    if (!result.trim()) throw new Error("Google Translate 没有返回译文");
    return result.trim();
}

async function translateBing(config: TranslationServiceConfig, text: string, target: string): Promise<string> {
    const pageUrl = (config.baseURL || "https://www.bing.com/translator")
        .trim()
        .replace("cn.bing.com", "www.bing.com")
        .replace(/\/+$/, "");
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
    const page = await httpRequest(pageUrl, {headers: {"User-Agent": ua, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"}, timeout: 25_000});
    if (page.status < 200 || page.status >= 300) {
        throw new Error(`Bing Translator HTTP ${page.status}`);
    }
    const ig = (page.text.match(/"ig":"(.*?)"/) || [])[1] || "";
    const iidMatches = page.text.match(/data-iid="(.*?)"/g) || [];
    const iid = iidMatches.length ? (iidMatches[iidMatches.length - 1].match(/data-iid="(.*?)"/) || [])[1] || "" : "";
    const params = page.text.match(/params_AbusePreventionHelper\s*=\s*\[(.*?),"(.*?)",/);
    if (!ig || !iid || !params) throw new Error("Bing Translator 页面令牌解析失败");
    const base = pageUrl.replace(/\/translator.*$/, "");
    const form = new URLSearchParams({
        fromLang: "auto-detect",
        to: codeFor("bing", target),
        text,
        token: params[2],
        key: params[1],
    });
    const response = await httpRequest(`${base}/ttranslatev3?IG=${encodeURIComponent(ig)}&IID=${encodeURIComponent(iid)}`, {
        method: "POST",
        headers: {"User-Agent": ua, "Content-Type": "application/x-www-form-urlencoded"},
        body: form.toString(),
        timeout: 30_000,
    });
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Bing Translator HTTP ${response.status}: ${response.text.slice(0, 200)}`);
    }
    const data = JSON.parse(response.text);
    if (data?.statusCode) throw new Error(`Bing Translator: ${data.errorMessage || data.statusCode}`);
    const result = data?.[0]?.translations?.[0]?.text;
    if (!result) throw new Error("Bing Translator 没有返回译文");
    return String(result).trim();
}

async function translateMyMemory(config: TranslationServiceConfig, text: string, target: string): Promise<string> {
    const source = /[\u3400-\u9fff]/.test(text) ? "zh-CN" : "en";
    const url = new URL(config.baseURL.replace(/\/+$/, "") + "/get");
    url.searchParams.set("q", text);
    url.searchParams.set("langpair", `${source}|${codeFor("mymemory", target)}`);
    const data = await getJson(url.href, {"User-Agent": "siyuan-pdf-zotero"});
    const result = data?.responseData?.translatedText;
    if (!result || /MYMEMORY WARNING/i.test(String(result))) {
        throw new Error(String(result || data?.responseDetails || "MyMemory 没有返回译文"));
    }
    return String(result).trim();
}

async function translateBaidu(config: TranslationServiceConfig, text: string, target: string): Promise<string> {
    const [appid, secret] = splitSecret(config.apiKey);
    if (!appid || !secret) throw new Error("百度翻译凭证格式应为 appid#secret");
    const salt = String(Date.now());
    const sign = hash("md5", `${appid}${text}${salt}${secret}`);
    const data = await postForm(config.baseURL, {
        q: text,
        from: "auto",
        to: codeFor("baidu", target),
        appid,
        salt,
        sign,
    });
    const result = data?.trans_result?.map((item: any) => item?.dst || "").join("\n");
    if (!result) throw new Error(data?.error_msg || "百度翻译没有返回译文");
    return result.trim();
}

async function translateYoudao(config: TranslationServiceConfig, text: string, target: string): Promise<string> {
    const [appKey, appSecret] = splitSecret(config.apiKey);
    if (!appKey || !appSecret) throw new Error("有道智云凭证格式应为 appKey#appSecret");
    const salt = String(Date.now());
    const curtime = String(Math.floor(Date.now() / 1000));
    const input = text.length <= 20 ? text : `${text.slice(0, 10)}${text.length}${text.slice(-10)}`;
    const sign = hash("sha256", `${appKey}${input}${salt}${curtime}${appSecret}`);
    const data = await postForm(config.baseURL, {
        q: text,
        from: "auto",
        to: codeFor("youdao", target),
        appKey,
        salt,
        sign,
        signType: "v3",
        curtime,
    });
    const result = data?.translation?.join("\n");
    if (!result) throw new Error(data?.errorCode ? `有道翻译错误码 ${data.errorCode}` : "有道翻译没有返回译文");
    return String(result).trim();
}

async function translateTencent(config: TranslationServiceConfig, text: string, target: string): Promise<string> {
    const [secretId, secretKey, region = "ap-guangzhou"] = splitSecret(config.apiKey);
    if (!secretId || !secretKey) throw new Error("腾讯云凭证格式应为 secretId#secretKey#region");
    const host = "tmt.tencentcloudapi.com";
    const endpoint = config.baseURL.replace(/\/+$/, "") || `https://${host}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const payload = JSON.stringify({SourceText: text, Source: "auto", Target: codeFor("tencent", target), ProjectId: 0});
    const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
    const signedHeaders = "content-type;host";
    const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hash("sha256", payload)}`;
    const credentialScope = `${date}/tmt/tc3_request`;
    const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${hash("sha256", canonicalRequest)}`;
    const secretDate = hmac("sha256", `TC3${secretKey}`, date);
    const secretService = hmac("sha256", Buffer.from(secretDate, "hex"), "tmt");
    const secretSigning = hmac("sha256", Buffer.from(secretService, "hex"), "tc3_request");
    const signature = hmac("sha256", Buffer.from(secretSigning, "hex"), stringToSign);
    const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const data = await postJson(endpoint, JSON.parse(payload), {
        Authorization: authorization,
        "X-TC-Action": "TextTranslate",
        "X-TC-Timestamp": String(timestamp),
        "X-TC-Version": "2018-03-21",
        "X-TC-Region": region,
    });
    const result = data?.Response?.TargetText;
    if (!result) throw new Error(data?.Response?.Error?.Message || "腾讯云翻译没有返回译文");
    return String(result).trim();
}

async function translateAliyun(config: TranslationServiceConfig, text: string, target: string): Promise<string> {
    const [accessKeyId, accessKeySecret] = splitSecret(config.apiKey);
    if (!accessKeyId || !accessKeySecret) throw new Error("阿里云凭证格式应为 accessKeyId#accessKeySecret");
    const params: Record<string, string> = {
        AccessKeyId: accessKeyId,
        Action: "TranslateGeneral",
        Format: "JSON",
        FormatType: "text",
        Scene: "general",
        SignatureMethod: "HMAC-SHA1",
        SignatureNonce: String(Date.now()),
        SignatureVersion: "1.0",
        SourceLanguage: "auto",
        SourceText: text,
        TargetLanguage: codeFor("aliyun", target),
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        Version: "2018-10-12",
    };
    const canonical = Object.keys(params).sort().map(key => `${rfc3986(key)}=${rfc3986(params[key])}`).join("&");
    const stringToSign = `GET&${rfc3986("/")}&${rfc3986(canonical)}`;
    const signature = hmac("sha1", `${accessKeySecret}&`, stringToSign, "base64");
    const query = `${canonical}&Signature=${rfc3986(signature)}`;
    const data = await getJson(`${config.baseURL.replace(/\/+$/, "")}/?${query}`);
    const result = data?.Data?.Translated;
    if (!result) throw new Error(data?.Message || "阿里云翻译没有返回译文");
    return String(result).trim();
}

async function translateAzure(config: TranslationServiceConfig, text: string, target: string): Promise<string> {
    const [key, region] = splitSecret(config.apiKey);
    if (!key) throw new Error("Azure Translator 凭证格式应为 key#region");
    const url = new URL(`${config.baseURL.replace(/\/+$/, "")}/translate`);
    url.searchParams.set("api-version", "3.0");
    url.searchParams.set("to", codeFor("azure", target));
    const headers: Record<string, string> = {"Ocp-Apim-Subscription-Key": key};
    if (region) headers["Ocp-Apim-Subscription-Region"] = region;
    const data = await postJson(url.href, [{Text: text}], headers);
    const result = data?.[0]?.translations?.[0]?.text;
    if (!result) throw new Error("Azure Translator 没有返回译文");
    return String(result).trim();
}

async function translateCaiyun(config: TranslationServiceConfig, text: string, target: string): Promise<string> {
    if (!config.apiKey.trim()) throw new Error("彩云小译缺少 token");
    const data = await postJson(config.baseURL, {
        source: [text],
        trans_type: codeFor("caiyun", target),
        request_id: `siyuan-${Date.now()}`,
        detect: true,
    }, {"x-authorization": config.apiKey});
    const result = data?.target?.[0];
    if (!result) throw new Error("彩云小译没有返回译文");
    return String(result).trim();
}

export async function translateText(
    service: TranslationServiceConfig,
    text: string,
    targetLang: string,
): Promise<TranslationResult> {
    const value = String(text || "").trim();
    if (!value) throw new Error("没有可翻译的文本");
    let result = "";
    switch (service.type) {
        case "siyuan-ai": result = await translateSiyuanAI(service, value, targetLang); break;
        case "openai": result = await translateOpenAICompatible(service, value, targetLang); break;
        case "deepl": result = await translateDeepL(service, value, targetLang); break;
        case "google": result = await translateGoogle(service, value, targetLang); break;
        case "bing": result = await translateBing(service, value, targetLang); break;
        case "mymemory": result = await translateMyMemory(service, value, targetLang); break;
        case "baidu": result = await translateBaidu(service, value, targetLang); break;
        case "youdao": result = await translateYoudao(service, value, targetLang); break;
        case "tencent": result = await translateTencent(service, value, targetLang); break;
        case "aliyun": result = await translateAliyun(service, value, targetLang); break;
        case "azure": result = await translateAzure(service, value, targetLang); break;
        case "caiyun": result = await translateCaiyun(service, value, targetLang); break;
        default: throw new Error(`不支持的翻译服务：${service.type}`);
    }
    return {text: result, service: service.name || service.type};
}
