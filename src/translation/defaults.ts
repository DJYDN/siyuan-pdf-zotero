import type {Settings, TranslationServiceConfig} from "../types";

export function activeTranslationService(settings: Settings): TranslationServiceConfig | null {
    const services = settings.translationServices || [];
    return services.find(item => item.id === settings.translationActiveServiceId && item.enabled)
        || services.find(item => item.enabled)
        || services[0]
        || null;
}

export const TRANSLATION_SERVICE_TYPES: ReadonlyArray<{type: TranslationServiceConfig["type"]; label: string}> = [
    {type: "siyuan-ai", label: "思源内置 AI"},
    {type: "openai", label: "OpenAI 兼容"},
    {type: "deepl", label: "DeepL"},
    {type: "google", label: "Google Translate"},
    {type: "baidu", label: "百度翻译"},
    {type: "youdao", label: "有道智云"},
    {type: "tencent", label: "腾讯云翻译"},
    {type: "aliyun", label: "阿里云翻译"},
    {type: "azure", label: "Azure Translator"},
    {type: "caiyun", label: "彩云小译"},
];

export function defaultTranslationServices(): TranslationServiceConfig[] {
    return [
        {id: "translation-siyuan-ai", type: "siyuan-ai", name: "思源内置 AI", enabled: true, baseURL: "", apiKey: "", model: ""},
        {id: "translation-openai", type: "openai", name: "OpenAI 兼容", enabled: true, baseURL: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini"},
        {id: "translation-deepl", type: "deepl", name: "DeepL", enabled: true, baseURL: "https://api-free.deepl.com/v2", apiKey: "", model: ""},
        {id: "translation-google", type: "google", name: "Google Translate", enabled: true, baseURL: "https://translate.googleapis.com", apiKey: "", model: ""},
        {id: "translation-baidu", type: "baidu", name: "百度翻译", enabled: true, baseURL: "https://fanyi-api.baidu.com/api/trans/vip/translate", apiKey: "", model: ""},
        {id: "translation-youdao", type: "youdao", name: "有道智云", enabled: true, baseURL: "https://openapi.youdao.com/api", apiKey: "", model: ""},
        {id: "translation-tencent", type: "tencent", name: "腾讯云翻译", enabled: true, baseURL: "https://tmt.tencentcloudapi.com", apiKey: "", model: ""},
        {id: "translation-aliyun", type: "aliyun", name: "阿里云翻译", enabled: true, baseURL: "https://mt.aliyuncs.com", apiKey: "", model: ""},
        {id: "translation-azure", type: "azure", name: "Azure Translator", enabled: true, baseURL: "https://api.cognitive.microsofttranslator.com", apiKey: "", model: ""},
        {id: "translation-caiyun", type: "caiyun", name: "彩云小译", enabled: true, baseURL: "https://api.interpreter.caiyunai.com/v1/translator", apiKey: "", model: ""},
    ];
}
