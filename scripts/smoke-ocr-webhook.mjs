#!/usr/bin/env node
import crypto from 'node:crypto';
import axios from 'axios';

const {
  OCR_WEBHOOK_URL: ocrWebhookUrl,
  OCR_WEBHOOK_SECRET: ocrWebhookSecret,
  OPENAI_API_KEY: openaiApiKey,
  AZURE_VISION_ENDPOINT: azureVisionEndpoint,
  AZURE_VISION_KEY: azureVisionKey,
} = process.env;

const SAMPLE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
const SAMPLE_PDF_BASE64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NyA+PgpzdHJlYW0KQlQKL0YxIDE4IFRmCjcyIDEwMCBUZAooQ2FudmFzIE9DUiBTbW9rZSkgVGoKRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMzggMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MDgKJSVFT0YK';

const signBody = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

if (!ocrWebhookUrl) {
  console.error('FAIL smoke setup: OCR_WEBHOOK_URL is required');
  process.exit(1);
}

const callWebhook = async (payload) => {
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'X-Request-ID': `smoke-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`,
  };
  if (ocrWebhookSecret) {
    headers['X-Signature'] = signBody(ocrWebhookSecret, body);
  }
  const response = await axios.post(ocrWebhookUrl, body, {
    headers,
    timeout: 20_000,
    maxBodyLength: Infinity,
    transformRequest: [(data) => data],
  });
  return { response, headers, body };
};

const results = [];
let failures = 0;

const recordFailure = (label, error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAIL ${label}: ${message}`);
  failures += 1;
};

if (openaiApiKey) {
  try {
    const { response } = await callWebhook({
      mime: 'image/png',
      dataBase64: SAMPLE_PNG_BASE64,
    });
    const engine = response.data?.meta?.engine;
    if (response.status !== 200) {
      throw new Error(`expected 200, got ${response.status}`);
    }
    if (engine !== 'openai-vision') {
      throw new Error(`expected meta.engine=openai-vision, got ${engine ?? 'undefined'}`);
    }
    console.log(`PASS openai-image (duration=${response.data?.meta?.durationMs ?? 'n/a'}ms)`);
  } catch (error) {
    recordFailure('openai-image', error);
  }
} else {
  results.push('SKIP openai-image (OPENAI_API_KEY not set)');
}

const hasAzureCreds = Boolean(azureVisionEndpoint && azureVisionKey);
if (hasAzureCreds) {
  try {
    const { response } = await callWebhook({
      mime: 'application/pdf',
      dataBase64: SAMPLE_PDF_BASE64,
      languages: ['eng'],
      maxPages: 1,
    });
    const engine = response.data?.meta?.engine;
    if (response.status !== 200) {
      throw new Error(`expected 200, got ${response.status}`);
    }
    if (engine !== 'azure-read') {
      throw new Error(`expected meta.engine=azure-read, got ${engine ?? 'undefined'}`);
    }
    console.log(`PASS azure-pdf (duration=${response.data?.meta?.durationMs ?? 'n/a'}ms)`);
  } catch (error) {
    recordFailure('azure-pdf', error);
  }
} else {
  results.push('SKIP azure-pdf (AZURE_VISION_ENDPOINT & AZURE_VISION_KEY not set)');
}

for (const entry of results) {
  console.log(entry);
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log('OCR smoke complete');
}
