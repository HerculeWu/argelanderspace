// Faithful port of the ArgelanderSpace design mock (project/data.js). Served by
// api/library.ts as a fallback when the backend is unreachable, so the Library
// view stays interactive (demo mode; discovery is disabled there — Stage 14 D9).

import type { GraphData, LibraryData, LibraryRef } from "./types";

const project = {
  name: "Galaxy Morphology @ Hubble Legacy",
  short: "GM-CNN",
  field: "Astrophysics · Deep Learning",
};

const tags = ["#CNN", "#galaxy-zoo", "#uncertainty", "#SDSS", "#ViT", "#benchmark", "#augmentation"];

const refs: LibraryRef[] = [
  { id: "r1", title: "Rotation-invariant convolutional neural networks for galaxy morphology prediction", authors: "Dieleman, Willett & Dambre", year: 2015, venue: "MNRAS", type: "article", cite: "dieleman2015", tags: ["#CNN", "#galaxy-zoo"], pdf: true, read: true, note: "Reproduce on the GM-CNN sample; compare with Willett 2013 labels.", star: true },
  { id: "r2", title: "Improving galaxy morphologies for SDSS with Deep Learning", authors: "Domínguez Sánchez et al.", year: 2018, venue: "MNRAS", type: "article", cite: "dominguez2018", tags: ["#CNN", "#SDSS", "#benchmark"], pdf: true, read: true, star: false },
  { id: "r3", title: "Dropout as a Bayesian Approximation: Representing Model Uncertainty in Deep Learning", authors: "Gal & Ghahramani", year: 2016, venue: "ICML", type: "conf", cite: "gal2016", tags: ["#uncertainty"], pdf: true, read: true, note: "Cite in the uncertainty section.", star: true },
  { id: "r4", title: "Galaxy Zoo: probabilistic morphological classification", authors: "Willett et al.", year: 2013, venue: "MNRAS", type: "article", cite: "willett2013", tags: ["#galaxy-zoo", "#benchmark"], pdf: true, read: true, star: false },
  { id: "r5", title: "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale", authors: "Dosovitskiy et al.", year: 2021, venue: "ICLR", type: "conf", cite: "dosovitskiy2021", tags: ["#ViT", "#benchmark"], pdf: true, read: false, star: false },
  { id: "r6", title: "Data augmentation strategies for galaxy image classification", authors: "Kim & Brunner", year: 2017, venue: "MNRAS", type: "article", cite: "kim2017", tags: ["#augmentation", "#SDSS"], pdf: false, read: false, star: false },
  { id: "r7", title: "The Sloan Digital Sky Survey: Technical Summary", authors: "York et al.", year: 2000, venue: "AJ", type: "article", cite: "york2000", tags: ["#SDSS"], pdf: true, read: true, star: false },
  { id: "r8", title: "Deep Residual Learning for Image Recognition", authors: "He, Zhang, Ren & Sun", year: 2016, venue: "CVPR", type: "conf", cite: "he2016", tags: ["#CNN", "#benchmark"], pdf: true, read: true, note: "Baseline architecture.", star: false },
];

const graph: GraphData = {
  // Stage 14: the Library graph is saved-only (the suggested-node architecture
  // is retired); the version marks the current cache format. Demo mode offers
  // NO discovery fallback (stage plan D9).
  version: 2,
  nodes: [
    { id: "dieleman2015", ref: "r1", y: 2015, c: 640, a: "Dieleman et al.", v: "MNRAS", t: "Rotation-invariant CNNs for galaxy morphology prediction" },
    { id: "dominguez2018", ref: "r2", y: 2018, c: 360, a: "Domínguez Sánchez+", v: "MNRAS", t: "Improving SDSS galaxy morphologies with deep learning" },
    { id: "gal2016", ref: "r3", y: 2016, c: 9100, a: "Gal & Ghahramani", v: "ICML", t: "Dropout as a Bayesian approximation" },
    { id: "willett2013", ref: "r4", y: 2013, c: 920, a: "Willett et al.", v: "MNRAS", t: "Galaxy Zoo 2: morphological classifications" },
    { id: "dosovitskiy2021", ref: "r5", y: 2021, c: 41000, a: "Dosovitskiy et al.", v: "ICLR", t: "An image is worth 16×16 words (ViT)" },
    { id: "kim2017", ref: "r6", y: 2017, c: 130, a: "Kim & Brunner", v: "MNRAS", t: "Data augmentation for galaxy image classification" },
    { id: "york2000", ref: "r7", y: 2000, c: 12500, a: "York et al.", v: "AJ", t: "The Sloan Digital Sky Survey: technical summary" },
    { id: "he2016", ref: "r8", y: 2016, c: 182000, a: "He et al.", v: "CVPR", t: "Deep residual learning for image recognition" },
  ],
  links: [
    ["york2000", "willett2013"], ["york2000", "dominguez2018"],
    ["willett2013", "dieleman2015"], ["willett2013", "dominguez2018"],
    ["dieleman2015", "dominguez2018"], ["dieleman2015", "kim2017"],
    ["he2016", "dosovitskiy2021"],
  ],
};

export const LIBRARY_FIXTURE: LibraryData = { project, refs, tags, graph };
