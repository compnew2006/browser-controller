/**
 * The wire boundary of this product.
 *
 * Everything that defines what crosses a connection lives here: the version
 * and the capabilities, the frames, the authentication of the handshake, and
 * the names a wire tool may have. The package imports nothing from the tools
 * layer, so the transport can be read (and changed) without knowing what the
 * tools do.
 */
export * from './auth.js';
export * from './capabilities.js';
export * from './frames.js';
export * from './wire-tools.js';
export { TOOL_NAMES } from './tool-names.js';
