// Vercel function: real Mutinynet Lightning practice payment — invoice.
import { practiceHandler } from '../../src/practice-endpoint.js';

export default function handler(req, res) { return practiceHandler(req, res, 'invoice'); }
