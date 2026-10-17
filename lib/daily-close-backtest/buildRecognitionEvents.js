// Compatibility adapter. Sales recognition authority lives in ventas/resolveVentasRecognition.js.
// Historical/backtest consumers must not own an independent recognition implementation.
export { buildVentasRecognitionEvents as buildRecognitionEvents } from '../ventas/resolveVentasRecognition.js';
