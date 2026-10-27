// Vercel function: QR code (SVG) for a practice Lightning invoice.
import { practiceHandler } from '../../src/practice-endpoint.js';

export default function handler(req, res) { return practiceHandler(req, res, 'qr'); }
