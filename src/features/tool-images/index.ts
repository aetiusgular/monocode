import { isMonoSession } from "../monos/model/mono";
import { skipToolImagesFor } from "./data/toolImageStore";

// A Mono's conversation is stored page by page, and deleting it would leave
// most of its tool-result images behind. Until that is handled they are not
// kept for a Mono at all.
skipToolImagesFor(isMonoSession);

export { sessionImagePaths } from "./model/toolImages";
export { PreviewSection } from "./ui/PreviewSection";
export { ToolImageGalleryHost } from "./ui/ToolImageGallery";
export { ToolImageStrip } from "./ui/ToolImageStrip";
