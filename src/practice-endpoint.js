// One practice service per warm serverless process (Vercel) or preview server.
// Configuration comes from the environment: NWC_RECEIVER_CONNECTION_SECRET
// (receive-only), PAYMENT_ENVIRONMENT=signet and LNBITS_NETWORK=signet.
import { createPracticeHandler, createPracticeService } from './practice-lightning.js';

export const practiceHandler = createPracticeHandler(createPracticeService());
