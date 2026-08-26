// Faithful port of the ArgelanderSpace design mock (project/data.js). Served by
// api/library.ts as a fallback until the real /api/library/* endpoints exist,
// so the Library view is fully interactive during frontend development.

import type { GraphData, LibraryData, LibraryRef } from "./types";

const project = {
  name: "Galaxy Morphology @ Hubble Legacy",
  short: "GM-CNN",
  field: "Astrophysics · Deep Learning",
};

const tags = ["#CNN", "#galaxy-zoo", "#uncertainty", "#SDSS", "#ViT", "#benchmark", "#augmentation"];

const refs: LibraryRef[] = [
  { id: "r1", title: "Rotation-invariant convolutional neural networks for galaxy morphology prediction", authors: "Dieleman, Willett & Dambre", year: 2015, venue: "MNRAS", type: "article", cite: "dieleman2015", tags: ["#CNN", "#galaxy-zoo"], pdf: true, read: true, note: true, star: true },
  { id: "r2", title: "Improving galaxy morphologies for SDSS with Deep Learning", authors: "Domínguez Sánchez et al.", year: 2018, venue: "MNRAS", type: "article", cite: "dominguez2018", tags: ["#CNN", "#SDSS", "#benchmark"], pdf: true, read: true, note: false, star: false },
  { id: "r3", title: "Dropout as a Bayesian Approximation: Representing Model Uncertainty in Deep Learning", authors: "Gal & Ghahramani", year: 2016, venue: "ICML", type: "conf", cite: "gal2016", tags: ["#uncertainty"], pdf: true, read: true, note: true, star: true },
  { id: "r4", title: "Galaxy Zoo: probabilistic morphological classification", authors: "Willett et al.", year: 2013, venue: "MNRAS", type: "article", cite: "willett2013", tags: ["#galaxy-zoo", "#benchmark"], pdf: true, read: true, note: false, star: false },
  { id: "r5", title: "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale", authors: "Dosovitskiy et al.", year: 2021, venue: "ICLR", type: "conf", cite: "dosovitskiy2021", tags: ["#ViT", "#benchmark"], pdf: true, read: false, note: false, star: false },
  { id: "r6", title: "Data augmentation strategies for galaxy image classification", authors: "Kim & Brunner", year: 2017, venue: "MNRAS", type: "article", cite: "kim2017", tags: ["#augmentation", "#SDSS"], pdf: false, read: false, note: false, star: false },
  { id: "r7", title: "The Sloan Digital Sky Survey: Technical Summary", authors: "York et al.", year: 2000, venue: "AJ", type: "article", cite: "york2000", tags: ["#SDSS"], pdf: true, read: true, note: false, star: false },
  { id: "r8", title: "Deep Residual Learning for Image Recognition", authors: "He, Zhang, Ren & Sun", year: 2016, venue: "CVPR", type: "conf", cite: "he2016", tags: ["#CNN", "#benchmark"], pdf: true, read: true, note: true, star: false },
];

const graph: GraphData = {
  nodes: [
    // saved (8)
    { id: "dieleman2015", ref: "r1", y: 2015, c: 640, a: "Dieleman et al.", v: "MNRAS", t: "Rotation-invariant CNNs for galaxy morphology prediction" },
    { id: "dominguez2018", ref: "r2", y: 2018, c: 360, a: "Domínguez Sánchez+", v: "MNRAS", t: "Improving SDSS galaxy morphologies with deep learning" },
    { id: "gal2016", ref: "r3", y: 2016, c: 9100, a: "Gal & Ghahramani", v: "ICML", t: "Dropout as a Bayesian approximation" },
    { id: "willett2013", ref: "r4", y: 2013, c: 920, a: "Willett et al.", v: "MNRAS", t: "Galaxy Zoo 2: morphological classifications" },
    { id: "dosovitskiy2021", ref: "r5", y: 2021, c: 41000, a: "Dosovitskiy et al.", v: "ICLR", t: "An image is worth 16×16 words (ViT)" },
    { id: "kim2017", ref: "r6", y: 2017, c: 130, a: "Kim & Brunner", v: "MNRAS", t: "Data augmentation for galaxy image classification" },
    { id: "york2000", ref: "r7", y: 2000, c: 12500, a: "York et al.", v: "AJ", t: "The Sloan Digital Sky Survey: technical summary" },
    { id: "he2016", ref: "r8", y: 2016, c: 182000, a: "He et al.", v: "CVPR", t: "Deep residual learning for image recognition" },
    // suggested (related, not in library)
    { id: "lecun1998", y: 1998, c: 51000, a: "LeCun et al.", v: "Proc. IEEE", t: "Gradient-based learning applied to document recognition" },
    { id: "krizhevsky2012", y: 2012, c: 123000, a: "Krizhevsky et al.", v: "NeurIPS", t: "ImageNet classification with deep CNNs (AlexNet)" },
    { id: "simonyan2014", y: 2014, c: 104000, a: "Simonyan & Zisserman", v: "ICLR", t: "Very deep CNNs for large-scale image recognition (VGG)" },
    { id: "szegedy2015", y: 2015, c: 46000, a: "Szegedy et al.", v: "CVPR", t: "Going deeper with convolutions (GoogLeNet)" },
    { id: "vaswani2017", y: 2017, c: 115000, a: "Vaswani et al.", v: "NeurIPS", t: "Attention is all you need" },
    { id: "kendall2017", y: 2017, c: 6200, a: "Kendall & Gal", v: "NeurIPS", t: "What uncertainties do we need in Bayesian deep learning?" },
    { id: "lintott2008", y: 2008, c: 1600, a: "Lintott et al.", v: "MNRAS", t: "Galaxy Zoo: morphologies from visual inspection" },
    { id: "banerji2010", y: 2010, c: 410, a: "Banerji et al.", v: "MNRAS", t: "Galaxy classification with artificial neural networks" },
    { id: "huertas2015", y: 2015, c: 380, a: "Huertas-Company+", v: "ApJS", t: "A catalog of visual-like morphologies via deep learning" },
    { id: "khan2018", y: 2018, c: 160, a: "Khan et al.", v: "Phys.Lett.B", t: "Deep transfer learning for star–galaxy classification" },
    { id: "walmsley2020", y: 2020, c: 260, a: "Walmsley et al.", v: "MNRAS", t: "Galaxy Zoo DECaLS: Bayesian CNN morphologies" },
    { id: "ghosh2020", y: 2020, c: 95, a: "Ghosh et al.", v: "ApJ", t: "GaMorNet: a CNN for galaxy morphology without sims" },
    { id: "cheng2020", y: 2020, c: 135, a: "Cheng et al.", v: "MNRAS", t: "Optimising automatic morphological classification" },
    { id: "bottrell2019", y: 2019, c: 115, a: "Bottrell et al.", v: "MNRAS", t: "Realistic mock observations for training CNNs" },
    // deeper layers (references-of-references; reached at depth ≥ 2)
    { id: "rumelhart1986", y: 1986, c: 40000, a: "Rumelhart et al.", v: "Nature", t: "Learning representations by back-propagating errors" },
    { id: "hochreiter1997", y: 1997, c: 90000, a: "Hochreiter & Schmidhuber", v: "Neural Comput.", t: "Long short-term memory" },
    { id: "glorot2010", y: 2010, c: 22000, a: "Glorot & Bengio", v: "AISTATS", t: "Understanding the difficulty of training deep networks" },
    { id: "ioffe2015", y: 2015, c: 55000, a: "Ioffe & Szegedy", v: "ICML", t: "Batch normalization: accelerating deep network training" },
    { id: "nair2010", y: 2010, c: 18000, a: "Nair & Hinton", v: "ICML", t: "Rectified linear units improve restricted Boltzmann machines" },
    { id: "abazajian2009", y: 2009, c: 6500, a: "Abazajian et al.", v: "ApJS", t: "The Seventh Data Release of the Sloan Digital Sky Survey" },
    { id: "fukushima1980", y: 1980, c: 8000, a: "Fukushima", v: "Biol. Cybern.", t: "Neocognitron: a self-organizing neural network model" },
    { id: "bengio1994", y: 1994, c: 12000, a: "Bengio et al.", v: "IEEE TNN", t: "Learning long-term dependencies with gradient descent is difficult" },
    { id: "gunn1998", y: 1998, c: 3000, a: "Gunn et al.", v: "AJ", t: "The Sloan Digital Sky Survey photometric camera" },
  ],
  links: [
    ["lecun1998", "krizhevsky2012"], ["krizhevsky2012", "simonyan2014"], ["krizhevsky2012", "szegedy2015"],
    ["krizhevsky2012", "he2016"], ["simonyan2014", "he2016"], ["simonyan2014", "szegedy2015"], ["szegedy2015", "he2016"],
    ["he2016", "dosovitskiy2021"], ["vaswani2017", "dosovitskiy2021"], ["he2016", "walmsley2020"], ["he2016", "cheng2020"],
    ["he2016", "khan2018"], ["krizhevsky2012", "dieleman2015"], ["simonyan2014", "ghosh2020"],
    ["gal2016", "kendall2017"], ["gal2016", "walmsley2020"], ["kendall2017", "walmsley2020"],
    ["york2000", "lintott2008"], ["york2000", "willett2013"], ["york2000", "dominguez2018"], ["york2000", "banerji2010"],
    ["lintott2008", "willett2013"], ["lintott2008", "banerji2010"], ["lintott2008", "dieleman2015"],
    ["willett2013", "dieleman2015"], ["willett2013", "dominguez2018"], ["willett2013", "huertas2015"], ["willett2013", "walmsley2020"],
    ["banerji2010", "dieleman2015"], ["banerji2010", "huertas2015"],
    ["dieleman2015", "dominguez2018"], ["dieleman2015", "kim2017"], ["dieleman2015", "huertas2015"], ["dieleman2015", "khan2018"],
    ["dieleman2015", "cheng2020"], ["dieleman2015", "ghosh2020"], ["dieleman2015", "bottrell2019"],
    ["huertas2015", "dominguez2018"], ["huertas2015", "khan2018"], ["dominguez2018", "walmsley2020"], ["dominguez2018", "cheng2020"],
    ["kim2017", "bottrell2019"], ["kim2017", "ghosh2020"],
    ["rumelhart1986", "krizhevsky2012"], ["rumelhart1986", "lecun1998"],
    ["hochreiter1997", "vaswani2017"],
    ["glorot2010", "simonyan2014"], ["glorot2010", "szegedy2015"],
    ["ioffe2015", "szegedy2015"], ["ioffe2015", "krizhevsky2012"],
    ["nair2010", "krizhevsky2012"], ["nair2010", "glorot2010"],
    ["abazajian2009", "lintott2008"], ["abazajian2009", "banerji2010"],
    ["fukushima1980", "rumelhart1986"], ["fukushima1980", "lecun1998"],
    ["bengio1994", "hochreiter1997"],
    ["gunn1998", "abazajian2009"],
  ],
};

export const LIBRARY_FIXTURE: LibraryData = { project, refs, tags, graph };
