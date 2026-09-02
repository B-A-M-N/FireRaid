/**
 * Runtime barrel — exports the Node origin server for non-Worker deployments.
 */
export { createOriginServer, closeServer } from "./node.js";
