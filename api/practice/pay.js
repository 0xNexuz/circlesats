// Vercel function: real Mutinynet Lightning practice payment — pay.
import { practiceHandler } from '../../src/practice-endpoint.js';

export default function handler(req, res) { return practiceHandler(req, res, 'pay'); }
