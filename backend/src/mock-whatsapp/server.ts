import { createMockWhatsApp } from './app.js';

const port = Number(process.env.PORT ?? 4100);
const { app } = createMockWhatsApp({
  failRate: Number(process.env.MOCK_FAIL_RATE ?? 0.2),
  timeoutRate: Number(process.env.MOCK_TIMEOUT_RATE ?? 0.1),
});
app.listen(port, () => console.log(`mock WhatsApp provider listening on ${port}`));
