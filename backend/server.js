// Reelio AI — защищённый backend.
//
// Две зоны ответственности:
//   1. /edit-plan — вызов Gemini, строго типизированный JSON-план монтажа;
//   2. /render, /jobs/{id}, /jobs/{id}/cancel, /download — координация рендера
//      по контракту docs/render-contract.md (настоящий MP4 собирает отдельный
//      FFmpeg worker в Cloud Run Job).
//
// ВАЖНО: GEMINI_API_KEY и токен worker'а читаются ТОЛЬКО из окружения и никогда
// не логируются, не возвращаются клиенту и не попадают в тексты ошибок.

import { createApp } from './src/app.js';
import { config } from './src/config.js';

const app = await createApp(config);

app.listen(config.port, () => {
  // Печатаем только факты конфигурации, без единого секрета.
  console.log(
    `reelio-backend on :${config.port} ` +
      `(gemini: ${Boolean(config.gemini.apiKey)}, render: ${config.render.mode})`,
  );
});
