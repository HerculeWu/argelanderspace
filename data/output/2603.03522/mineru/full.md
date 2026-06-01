# Most open clusters follow the radial acceleration relation (RAR) and the baryonic Tully-Fisher relation (BTFR)

Mark D. Huisjes,1★ X. Hernandez2

1CSG De Goudse Waarden Lyceum, Heemskerkstraat 105, 2805SN Gouda   
2Universidad Nacional Autónoma de México, Instituto de Astronomía, A. P. 70-264, 04510, CDMX, México

# ABSTRACT

We test whether parsec-scale stellar systems in the Milky Way follow the galactic radial acceleration relation (RAR) or the baryonic Tully–Fisher relation (BTFR). We analyse 5646 Gaia DR3 open clusters from the Hunt & Reffert catalogue. Observed accelerations are derived from velocity dispersions and characteristic radii, and baryonic accelerations from stellar masses and characterisitc radii. The clusters are placed on the RAR and BTFR planes and compared with Newtonian and MOND expectations. Approximately 90 per cent of open clusters (those with ??★ ≤ 250) lie close to the RAR, albeit with significant scatter. In a first-of-its-kind test, a smaller fiducial sample is consistent with a best-fitting acceleration scale $g _ { \dagger } \approx 1 . 2 \times 1 0 ^ { - 1 0 } \mathrm { m } \mathrm { s } ^ { - 2 } \pm 0 . 5 \mathrm { d e x }$ , compatible with canonical MOND values. More massive clusters approach the Newtonian virial expectation. No correlations are found between RAR residuals and galactocentric radii, distance to the Galactic disk midplane, age, or morphology. Tidal effects and unresolved binaries are insufficient to reproduce the observations without fine-tuning. Interpreted within a MOND framework, the alignment of most open clusters with the RAR and BTFR suggests that low-acceleration dynamics operate on parsec scales within the Milky Way. This implies that the Galactic gravitational field is not smooth on these scales and may include regions where the total gravitational acceleration falls below $a _ { 0 } .$ , partially mitigating the external field effect, thereby motivating higher-resolution modelling of the Galactic potential and informing other small-scale gravity tests within the Galaxy.

Key words: kinematics and dynamics – open clusters and associations – proper motions – gravitation – acceleration of particles

# 1 INTRODUCTION

Empirical scaling relations have played a central role in shaping our understanding of galactic dynamics. Two of the most striking are the baryonic Tully–Fisher relation (BTFR), McGaugh et al. (2000), and the radial acceleration relation (RAR), McGaugh et al. (2016). The RAR links the observed gravitational acceleration in galaxies to that predicted from their baryonic mass distribution, while the BTFR connects total baryonic mass to asymptotic rotation velocity through a tight power-law relation. These relations hold across many decades in mass and surface density, with remarkably small intrinsic scatter. They are commonly interpreted either as emergent regularities of galaxy formation within dark matter halos or as manifestations of a modified law of gravity operative at low accelerations.

To date, these relations have primarily been tested on kiloparsec scales in rotating disc galaxies, dwarf spheroidals, and galaxy groups. Much less attention has been paid to whether analogous behaviour persists on parsec scales within galaxies. Open clusters (OCs) provide an opportunity to probe this regime. OCs are self-gravitating systems with characteristic internal accelerations that fall below Milgrom’s constant, $a _ { 0 } \sim 1 . 2 \times 1 0 ^ { - 1 0 } m s ^ { - 2 }$ , Milgrom (1983a). Unlike galaxies, however, they reside deep within the gravitational potential of the Milky Way. Their internal dynamics are therefore not only determined by their own mass distributions but also by the external Galactic field in which they are embedded.

Under modified Newtonian dynamics (MOND), this environmental dependence is formalized through the external field effect (EFE). Because the MOND field equation is non-linear, the internal dynamics of a system depend on the total gravitational field, including any ambient external contribution. A system whose internal accelerations are below ?? can nevertheless behave in a (quasi-)Newtonian manner if it is embedded in an external field comparable to or exceeding ??0. In the context of the Milky Way disc, the typical large-scale gravitational field near the solar circle is ∼ 1.5??0. Under the standard AQUAL and QUMOND Lagrangian formulations of MOND, open clusters located in such an environment are therefore expected to exhibit no MOND effects.

This theoretical expectation leads to a sharp test. If open clusters in the Galactic disc systematically follow the deep-MOND branch of the RAR despite being embedded in an external field of order ?? , then either the EFE operates differently than currently formulated, or the level of small-scale density fluctuations present in the galactic disc (e.g. Poggio et al. (2021), Ge et al. (2024)) lead to regions where the total gravitational potential is much smaller than ?? .

Conversely, if their dynamics are fully consistent with Newtonian expectations once tidal heating and the kinematic effects of unresolved binaries on the observed velocity dispersion are accounted for, then parsec-scale systems do not provide additional constraints on theories of gravity.

The central question addressed in this paper is therefore whether open clusters, when placed in the acceleration plane defined by the RAR and in the mass–velocity plane defined by the BTFR, align or not with the same relations observed in galaxies, and what this implies for the structure of the Galactic gravitational field. We analyse a large, homogeneous sample of 5646 open clusters from Hunt & Reffert (2021, 2023, 2024) to determine their observed kinematic accelerations and baryonic gravitational accelerations using consistent definitions. By comparing their locations in the RAR and BTFR planes to both Newtonian and MOND expectations, we test whether parsec-scale systems behave as if they are embedded in a smooth external field or instead generally occupy regions where the effective acceleration drops below $a _ { 0 }$ .

This approach allows us to analyse the relation between internal dynamics, external gravitational environment, and empirical scaling relations that were originally established on galactic scales.

# 2 MOND THEORY AND THE EXTERNAL FIELD EFFECT

Modified Newtonian Dynamics (MOND) is a modification of classical gravity proposed by Mordehai Milgrom in 1983 to account for the observed kinematics of galaxies without invoking non-baryonic dark matter (Milgrom 1983a,b,c). The central empirical motivation is the persistence of approximately flat rotation curves in disc galaxies at large radii, where the Newtonian gravitational acceleration inferred from the observed baryonic mass distribution would predict a declining orbital velocity. MOND posits that the law of gravity is modified only in regimes where the characteristic acceleration falls below a universal constant $a _ { 0 } \approx 1 . 2 { \times } 1 0 ^ { - 1 0 } \mathrm { m } \mathrm { s } ^ { - 2 }$ , while standard Newtonian gravity is recovered at accelerations well above this scale.

In MOND, the gravitational acceleration ???? experienced by a test particle deviates from the Newtonian value $g _ { N }$ when $g _ { N } \lesssim a _ { 0 }$ . The modification is commonly written in implicit form as

$$
\mu \left(\frac {g _ {M}}{a _ {0}}\right) g _ {M} = g _ {N} \tag {1}
$$

where $\mu ( x )$ is an interpolating function satisfying $\mu ( x ) \to 1$ for ?? ≫ 1 (recovering Newtonian gravity) and $\mu ( x )  x$ for ?? ≪ 1 (the deep-MOND regime). In the limit $g _ { N } \ll a _ { 0 }$ , this yields

$$
g _ {M} \approx \sqrt {g _ {N} a _ {0}} \tag {2}
$$

Equivalently, one may express the relation for convenience using the inverse interpolation function ??(??), defined such that

$$
g _ {M} = \nu \left(\frac {g _ {N}}{a _ {0}}\right) g _ {N} \tag {3}
$$

with $\nu ( y ) \to 1$ for $y \gg 1$ and $\nu ( y ) \to y ^ { - 1 / 2 }$ for $y \ll 1$ . This formulation emphasizes that MOND modifies the effective gravitational field at low accelerations rather than introducing additional unseen mass.

A principal consequence of the deep-MOND scaling $g _ { M } \propto \sqrt { g _ { N } }$ is that the gravitational field around an isolated mass declines asymptotically as $1 / r$ rather than $1 / r ^ { 2 }$ . For a point mass ??, the asymptotic circular velocity becomes radius-independent and satisfies

$$
V ^ {4} = G M a _ {0} \tag {4}
$$

which directly yields the baryonic Tully–Fisher relation with Milgrom’s constant as the normalization parameter. More generally, MOND permits rotation curves to be computed from the observed baryonic mass distribution with essentially one additional constant, $a _ { 0 } .$ . Conversely, observed rotation curves can be inverted to infer baryonic surface density profiles. On galactic scales, this predictive capacity is a defining empirical feature of the theory.

At galaxy cluster scales, however, MOND has typically been seen to fall short in fully explaining observed dynamics by still requiring a factor of 2 more mass than present in the baryons, although recently Zhang et al. (2026) have shown that for IMF choices restricted by the observed metallicities of the cluster galaxies, enough stellar remnants might be expected in the intra-cluster medium to significantly ameliorate this issue. Further, as a non-relativistic theory, MOND is unsuitable for addressing cosmological or gravitational lensing observations in general.

MOND can be formulated as a modified gravity theory derived from a Lagrangian. The original non-relativistic formulation, known as AQUAL (AQUAdratic Lagrangian) by Bekenstein & Milgrom (1984), replaces the Newtonian gravitational action with a non-linear functional of the gradient of the potential:

$$
\mathcal {L} \propto - a _ {0} ^ {2} F \left(\frac {\left| \nabla \Phi_ {t o t} \right| ^ {2}}{a _ {0} ^ {2}}\right) \tag {5}
$$

where the function ?? is chosen so that the resulting field equation below reproduces the ??-interpolation relation. This yields a modified Poisson equation of the form

$$
\nabla \cdot \left[ \mu \left(\frac {| \nabla \Phi_ {t o t} |}{a _ {0}}\right) \nabla \Phi_ {t o t} \right] = 4 \pi G \rho \tag {6}
$$

An alternative but dynamically equivalent formulation by Milgrom (2010), QUMOND (quasi-linear MOND), derives from a Lagrangian constructed so that the non-linear aspects are shifted into an algebraic relation involving the Newtonian potential. In QUMOND, one first computes the Newtonian potential from the baryonic mass distribution and then applies the ??-function to obtain the MOND correction, leading to a linear Poisson equation with an effective source term. Both AQUAL and QUMOND are non-relativistic Lagrangian realizations of MOND and ensure the usual conservation of energy and momentum within the modified gravitational framework.

While MOND has occasionally been explored as a modification of inertia, e.g. Milgrom (2022), in which the force–acceleration relation itself is altered, this interpretation remains less developed. The standard treatment regards MOND primarily as a non-linear modification of the gravitational field operative below a universal acceleration scale.

# 2.1 The external field effect

Because the MOND field equation is non-linear and depends on the total gravitational field, the internal dynamics of a self-gravitating system depend not only on its own mass distribution but also on any ambient gravitational field in which it is embedded. This phenomenon, known as the external field effect (EFE), arises even if the external field is spatially uniform and tidal forces are absent. Such behaviour has no equivalent in Newtonian gravity. A system whose internal accelerations are below $a _ { 0 }$ may nonetheless behave in a Newtonian manner if it resides in an external field exceeding ??0. The external field effectively suppresses the deep-MOND enhancement. When $g _ { i n t } < g _ { e x t } < a _ { 0 }$ the Milgromian enhancement is only partially suppressed and causes the internal dynamics to interpolate between Newtonian and Milgromian behaviour according to the total gravitational environment. This is called the quasi-Newtonian regime and is effectively equivalent to rescaling the gravitational constant G. For a graphical overview of the possible regimes see Fig. 1.

The EFE reflects a violation of the strong equivalence principle while preserving the weak equivalence principle1, as all test bodies still follow identical trajectories in a given gravitational field. The EFE has concrete implications for open clusters in galactic discs, dwarf satellite galaxies within host systems, and wide binary stars in the Milky Way, where the background galactic field can influence internal kinematics.

![](images/d80b374d8e7ccbd37e4e8a7b0af370412617ca299acefac5ce5a8d7f9e3aabf9.jpg)

<details>
<summary>line</summary>

| Newtonian gravity, g_N,int log(ms⁻²) | Newtonian gravity, g_M log(ms⁻²) | Deep-MOND gravity, g_M log(ms⁻²) | Quasi-Newtonian gravity, g_M log(ms⁻²) | Forced Newtonian gravity, g_M log(ms⁻²) |
| ------------------------------------- | ---------------------------------- | -------------------------------- | -------------------------------------- | --------------------------------------- |
| -16                                   | -7                                 | -13                              | -13                                    | -13                                     |
| -15                                   | -8                                 | -12                              | -12                                    | -12                                     |
| -14                                   | -9                                 | -11                              | -11                                    | -11                                     |
| -13                                   | -10                                | -10                              | -10                                    | -10                                     |
| -12                                   | -11                                | -9                               | -9                                     | -9                                      |
| -11                                   | -12                                | -8                               | -8                                     | -8                                      |
| -10                                   | -13                                | -7                               | -7                                     | -7                                      |
The data is used to plot four distinct lines representing different Newtonian models and forces. The labels for each line correspond to the model names and their corresponding values. The equation 'Using: g_N,ext = 10⁻¹³, 10⁻¹², 10⁻¹¹' is noted in the chart.
</details>

Figure 1. The four regimes of MOND, based on figure one of Banik & Zhao (2022).

The EFE can be approximated to first order for a system consisting of an internal and external Newtonian gravitational field contribution by changing equation 3 to the form below based on equation 60 by Famaey & McGaugh (2012).

$$
g _ {\mathrm{M}} = \left(g _ {\mathrm{N,int}} + g _ {\mathrm{N,ext}}\right) \nu \left(\frac {g _ {\mathrm{N,int}} + g _ {\mathrm{N,ext}}}{a _ {0}}\right) - g _ {\mathrm{N,ext}} \nu \left(\frac {g _ {\mathrm{N,ext}}}{a _ {0}}\right) \tag {7}
$$

There is now considerable observational evidence in favor of the EFE under MOND interpretations of astronomical data. For example observations by McGaugh & Milgrom (2013a,b) support the EFE in the velocity dispersions of dwarf satellite galaxies embedded in the gravitational field of their host. The EFE has also been detected in the outer edges of spiral galaxies by Chae et al. (2020) where rotation curves are affected by the gravitational field of the large scale structure of the universe. Recently, studies of the anomalous relative velocity between components of wide binaries in the Solar neighbourhood have yielded results consistent with the presence of standard MOND EFE phenomenology e.g. Hernandez et al. (2024), Chae (2024b). Finally laboratory Cavendish experiments using a torsion pendulum also point to the absence of any enhanced motion at low internal accelerations indicating either ordinary Newtonian mechanics or the presence of the external field effect due to the very strong gravitational field of the Earth (Gundlach et al. 2007).

Although open clusters were already mentioned in the foundational papers on MOND (Milgrom 1983a), analyses of these systems has remained sparse until recently. Open clusters have long been considered nearly Newtonian because of relatively small excess velocity dispersions and the dominant influence of the Galactic gravitational field. Indeed, open clusters were the original motivation for including the EFE in the initial development of MOND (Milgrom 1983a). According to Milgrom, Salpeter and Tremaine pointed out that open clusters in the solar neighbourhood showed no appreciable mismatch between their kinematic and stellar masses, despite having internal

baryonic accelerations well below $a _ { 0 } .$ . Of course, it is well known that under a Newtonian interpretation, open clusters are in the process of dissolving into the field, and indeed, abundant evidence exists showing these systems not to be equilibrium bound self-gravitating objects often presenting clear tidal features. It remains to be seen to what degree their present internal kinematics might retain information of their formation processes, a point which we investigate in detail in what follows.

# 3 SAMPLE SELECTION

We begin with the star cluster catalogue compiled by Hunt & Reffert (2021, 2023, 2024), henceforth HR134. This enables a systematic investigation of the dynamics of stellar subsystems in the Milky Way. The catalogue of clusters created by HR134 contains several types of over-densities such as what HR134 classifies as open clusters, moving groups, globular clusters and a "rejected" category that was classified as such manually. In this study we will only consider the 5646 clusters HR134 classifies as open clusters.

# 3.1 Data quality cuts

Two quality cuts were applied to the HR134 open clusters. The first is a distance cut, eliminating all clusters with a heliocentric distance greater than 3 kpc because beyond this distance completeness decreases and faint magnitude systematics become important contributors to the measured proper motion. This removes 1573 clusters from the sample. The second cut is to remove all clusters more than 150 pc away from the midplane of the disc as these are likely on orbits which cross the disc periodically and are particularly prone to tidal disruption. This removes another 454 clusters from the sample leaving a total of 3618 open clusters to be analysed.

The sample of 3618 open clusters is divided into three parts for analysis based on the number of resolved stars ??★. The first group has ??★ ≤ 250 and comprises 90% of the full science sample. The second group has 250 < ??★ ≤ 500 and accounts for another 6%. The third and final group has ??★ > 500 and consists of the remaining 4% of clusters.

A further fiducial high quality sample was selected from the ??★ ≤ 250 group which contained 2423 open clusters by requiring that each have a colour-magnitude diagram quality index exceeding 75%. This index, used by HR134, compares the CMD of an observed cluster to the best-fitting isochrone for it and estimates the fraction of stars which are consistent with this optimal isochrone, given observational errors, and the fraction which are likely foreground or background field contaminant stars. A value of 100% denotes all stars being likely cluster members consistent with the optimal isochrone, while a value of 0 would denote a cluster where all assigned member stars are probably contaminant non-cluster members.

# 3.2 Derived quantities

The heliocentric distance to each open cluster is estimated independently using two methods: a photometric method based on the distance modulus, and a geometric method based on parallax. An accurate distance is necessary to convert the measured proper motions to physical velocities.

For the photometric estimate, the 16th, 50th, and 84th percentiles of the distance modulus distribution given by the HR134 catalogue

![](images/ca92c92d1dd75c731ae725e355c4b2c5d0371997f837cedb3d6b9dde3bf5920a.jpg)  
Figure 2. Comparison of observed kinetic accelerations, $g _ { \mathrm { o b s } }$ , and Newtonian virial equilibrium accelerations, $g _ { \mathrm { b a r } }$ for the inferred masses, velocity dispersions and radii for the 3618 open clusters after our quality cuts from the HR134 catalogue. The colour number density shading gives the position of the 3251 $N _ { \star } \leq 2 5 0$ clusters which accurately trace the galactic RAR relation given by the solid curve. The solid squares show the 145 most massive $N _ { \star } \geq 5 0 0$ clusters, mostly tracing the Newtonian virial expectations, while the dots give the positions of the 222 intermediate mass $2 5 0 \leq N _ { \star } \leq 5 0 0$ clusters, filling the region in between the two previous populations.

are converted into distances via

$$
d = 1 0 ^ {(m - M) / 5 + 1}, \tag {8}
$$

yielding three corresponding distance estimates. A symmetric uncertainty is then defined as the mean of the upper and lower absolute deviations from the median distance. An analogous procedure is applied to the parallax-based distance estimate, again defining a central value and a symmetric uncertainty from its percentile range.

The two distance estimates are then combined using inversevariance weighting. Defining the weights as $w _ { \mathrm { p h o t } } = 1 / \bar { \sigma } _ { d , \mathrm { p h o t } } ^ { 2 }$ and $w _ { \pi } = 1 / \sigma _ { d , \pi } ^ { 2 }$ , the joint distance with standard error propagation is given by

$$
d _ {\text { joint }} = \frac {d _ {\text { phot }} w _ {\text { phot }} + d _ {\pi} w _ {\pi}}{w _ {\text { phot }} + w _ {\pi}}, \tag {9}
$$

$$
\sigma_ {d, \text { joint }} = \sqrt {\frac {1}{w _ {\text { phot }} + w _ {\pi}}}  . \tag {10}
$$

For the sample considered in this work, the photometric and parallax distances are nearly identical for most open clusters. Only beyond heliocentric distances of approximately 3 kpc do the two methods begin to diverge at the order-of-unity level. As a result, the joint estimator typically differs only marginally from either individual estimate within the bulk of the sample. As in HR134, raw Gaia parallaxes were corrected for the parallax zero point bias described by Lindegren et al. (2021) when calculating parallax distances.

The velocity dispersion given by the HR134 catalogue is calculated by taking the standard deviation of the proper motions. According to Section 3.3 of Hunt & Reffert (2023) mean cluster parameters were calculated over only those stars assigned to the cluster that have membership probabilities larger than 50% and are within the tidal radius of the cluster, so as to exclude any tidally perturbed stars within the tidal tails. This tidal radius is defined in a model independent way as the radius at which the overall cluster has the best contrast to field stars using the CST parameter produced by the HDBSCAN clustering algorithm. According to HR134, this is similar to the King (1962) definition of tidal radius as the radius at which a cluster’s density begins to exceed that of the density of the field. This was verified by recalculating the velocity dispersion from the individual member star proper motions using the "inrt" and "inrj" parameters of the catalogue which classify a star as being in- or outside of the tidal or Jacobi radius respectively. Further excluded are all those stars with $R U W E > 1 . 4$ . The catalogue does not weight the proper motions by their uncertainties in calculating the velocity dispersion. Here we adopt the velocity dispersion given by HR134 for each cluster, $\sigma _ { \star }$ .

We further recalculated $\sigma _ { \star }$ for each cluster directly from the individual member stars to test its sensitivity to using different selection criteria and methods of calculation. To test how sensitive the velocity dispersion is to the HDBSCAN derived membership probability, a magnitude cut $1 2 > G > 1 7$ was used instead, along with excluding all stars outside the tidal radius and with a $R U W E > 1 . 4$ and any with an available non-single star solution in Gaia DR3. This alternative selection did not significantly alter the velocity dispersion inferred for the clusters. A further cut excluding stars with $R U W E > 1 . 2$ only lowered the velocity dispersion by about 10%.

Following HR134, these recalculations corrected the raw Gaia proper motions for the proper motion bias of bright Gaia sources identified by Cantat-Gaudin & Brandt (2021). A further correction for the secular aberration drift due to the solar system’s acceleration towards ?????? ??∗ identified by Klioner et al. (2021) was also tested which did not noticeably alter the velocity dispersion when applied or not.

For each open cluster the baryonic gravitational and observed kinematic acceleration were determined based on the definitions of Lelli et al. (2017):

$$
g _ {\mathrm{obs}} = - \nabla \Phi_ {t o t} (R _ {1 / 2}) = \frac {\left(\sqrt {3} \sigma_ {\star}\right) ^ {2}}{R _ {1 / 2}} \tag {11}
$$

Where $\sigma _ { \star }$ is the mean one dimensional velocity dispersion of the stars, $R _ { 1 / 2 }$ is the half member radius and the factor $\sqrt { 3 }$ converts the one dimensional velocity dispersion to the full 3D velocity dispersion assuming isotropy. Instead of the factor ${ \sqrt { 3 } } ,$ McGaugh et al. (2021) suggests to use 2 as this empirically shifts dwarf galaxies onto the baryonic Tully-Fisher relation. He also notes that MOND predicts a factor of 2.12 for this parameter for deep-MOND isolated systems. Here we adhere to Lelli’s definition through the assumption of isotropy, in order to use a strict kinematic acceleration measure without introducing any relations like the RAR or the BTFR or any assumptions on the possible validity of MOND a priori. To convert the proper motions to physical units the joint distance mentioned previously was used.

The baryonic gravitational acceleration is computed from the total cluster mass ?? (in solar masses), assuming spherical symmetry and evaluating the Newtonian acceleration at the same characteristic radius as used above. Following Lelli et al. (2017), we adopt the factor 2 in the denominator appropriate for using the half-mass radius proxy:

$$
g _ {\text { bar }} = - \nabla \Phi_ {b a r} (R _ {1 / 2}) = \frac {G M}{2 R _ {1 / 2} ^ {2}} \tag {12}
$$

Hence, as described in this section, we obtain a set of $( \sigma _ { s t a r } .$ , ??, $R _ { 1 / 2 } , g _ { \mathrm { o b s } } , g _ { \mathrm { b a r } } )$ parameters for each of the 3618 open clusters clearing the quality cuts imposed on the HR134 catalogue.

# 4 RESULTS

We begin with Fig. 2 which shows the inferred $g _ { \mathrm { o b s } }$ and $g _ { \mathrm { b a r } }$ values for the three populations described previously, selected through a ranking on the number of stars present per cluster. We see the most massive ones well described by Newtonian virial equilibrium expectations, with the addition of a small distribution towards super-virial values in $g _ { \mathrm { o b s } }$ reflecting higher $\sigma _ { \star }$ values than what corresponds to the dashed Newtonian line shown. At the other extreme, the smallest clusters present a distribution following the radial acceleration relation, an empirical scaling well established at galactic scales, and

Radial acceleration relation & OCs   
![](images/edc5b81095b4650781e52a68599f73778972fa50186b557b51885433f4b43772.jpg)

<details>
<summary>heatmap</summary>

| g_bar log(ms⁻²) | g_obs log(ms⁻²) | Counts |
| --------------- | --------------- | ------ |
| -13 to -10      | -12 to -9       | N★ ≤ 250, R₅₀ = 3.83 pc, σ₃D = 1.47 km/s, M_median = 314.76 M☉, 90% of full sample |
</details>

Figure 3. Same data as shown in Fig. 2 but only for the smallest $N _ { \star } \leq 2 5 0$ clusters. The thin dotted line gives the resulting fit to these clusters to eq. 13, yielding an optimal fit acceleration scale almost identical to the standard ??0 value of MOND, which in turn results in the galactic RAR given by the solid curve. The equivalent fit using the fiducial $N _ { \star } < 2 5 0$ sub-sample with CMD quality> 75% clusters actually coincides with this solid curve.

clearly tracing MOND predictions of four decades ago. This RAR was originally found at baryonic mass scales some eight orders of magnitude above the small $\mathrm { O C s }$ studied here. In between the previous two populations we find intermediate mass clusters which populate the region between the two previously described, with a small dispersion extending towards either of the other two regions, as seen in Fig. 2

This division of the sample into three groups was done because they show markedly different positions in the acceleration plane. The exact boundaries between these groups are somewhat arbitrary as the characteristics of these clusters change smoothly up towards the highest number of resolved stars (and highest mass). While the specific membership thresholds chosen are arbitrary, the three distinct populations shown are robust to small changes in the details of these thresholds.

Although it might be more physically motivated to divide the sample based on the inferred stellar mass of the cluster, this would add numerous inferential steps each with its own assumptions and uncertainties. In practice, it was found that using the observational quantity ??★ provides a cleaner separation in the acceleration plane.

We now turn our attention to a more careful exploration of the $N _ { \star } \leq 2 5 0$ sample, shown in Fig. 3. This figure presents a zoom of the previous figure, together with, for the first time in the literature, a fit using this sample to the radial acceleration relation leaving $g _ { \dagger }$ as a free parameter,

$$
g _ {\mathrm{obs}} = \frac {g _ {\mathrm{bar}}}{1 - e ^ {- \sqrt {g _ {\mathrm{bar}} / g _ {\dagger}}}}. \tag {13}
$$

The inferred value we obtain is of an acceleration scale $g _ { \dagger } =$ $1 . 4 \times 1 0 ^ { - 1 0 } m s ^ { - 2 } \pm 0 . 5 d e x$ . Turning to the fiducial $N _ { \star } \leq 2 5 0$ subsample with a cleaned CMD the result of this inference becomes $g _ { \uparrow } = 1 . 2 \times 1 0 ^ { - 1 0 } m s ^ { - 2 } \pm 0 . 5 d e x$ . This matches the canonical MOND value for this quantity as first measured by Begeman et al. (1991), namely $a _ { 0 } = 1 . 2 1 \times \mathrm { 1 0 ^ { - 1 0 } } m s ^ { - 2 }$ but vastly less precise than modern values such as $a _ { 0 } = 1 . 2 0 \pm 0 . 0 2 \times 1 0 ^ { - 1 0 } m s ^ { - 2 } \mathrm { b y }$ y Lelli et al. (2017). In Fig. 3 the first fit is shown by the small dotted line, while the second is indistinguishable from the standard galactic RAR (again shown by the solid curve). The inset in Fig. 3 gives the distribution of residuals from the best fit RAR relation, which closely follow a Gaussian distribution, showing the data to be consistent with the fit presented to within effective errors in the determination of the plotted quantities.

![](images/ad041c737b61a89cacc3b8ec98c5d23ccc59f0167bbb90249d52e336bc65c6cd.jpg)

<details>
<summary>scatter</summary>

| Galaxy Type       | M_b (M☉) | V_c (km s⁻¹) |
| ----------------- | -------- | ------------ |
| Rotating galaxies | 10^2     | 0.5          |
| Rotating galaxies | 10^3     | 1.0          |
| Rotating galaxies | 10^4     | 2.0          |
| Rotating galaxies | 10^5     | 5.0          |
| Rotating galaxies | 10^6     | 10.0         |
| Rotating galaxies | 10^7     | 20.0         |
| Rotating galaxies | 10^8     | 50.0         |
| Rotating galaxies | 10^9     | 100.0        |
| Rotating galaxies | 10^10    | 200.0        |
| Rotating galaxies | 10^11    | 300.0        |
| Rotating galaxies | 10^12    | 500.0        |
| Galaxy groups     | 10^2     | 0.5          |
| Galaxy groups     | 10^3     | 1.0          |
| Galaxy groups     | 10^4     | 2.0          |
| Galaxy groups     | 10^5     | 5.0          |
| Galaxy groups     | 10^6     | 10.0         |
| Galaxy groups     | 10^7     | 20.0         |
| Galaxy groups     | 10^8     | 50.0         |
| Galaxy groups     | 10^9     | 100.0        |
| Galaxy groups     | 10^10    | 200.0        |
| Galaxy groups     | 10^11    | 300.0        |
| Galaxy groups     | 10^12    | 500.0        |
| Weak lensing      | 10^2     | 0.5          |
| Weak lensing      | 10^3     | 1.0          |
| Weak lensing      | 10^4     | 2.0          |
| Weak lensing      | 10^5     | 5.0          |
| Weak lensing      | 10^6     | 10.0         |
| Weak lensing      | 10^7     | 20.0         |
| Weak lensing      | 10^8     | 50.0         |
| Weak lensing      | 10^9     | 100.0        |
| Weak lensing      | 10^10    | 200.0        |
| Weak lensing      | 10^11    | 300.0        |
| Weak lensing      | 10^12    | 500.0        |
| Dwarf galaxies    | 10^2     | 0.5          |
| Dwarf galaxies    | 10^3     | 1.0          |
| Dwarf galaxies    | 10^4     | 2.0          |
| Dwarf galaxies    | 10^5     | 5.0          |
| Dwarf galaxies    | 10^6     | 10.0         |
| Dwarf galaxies    | 10^7     | 20.0         |
| Dwarf galaxies    | 10^8     | 50.0         |
| Dwarf galaxies    | 10^9     | 100.0        |
| Dwarf galaxies    | 10^10    | 200.0        |
| Dwarf galaxies    | 10^11    | 300.0        |
| Dwarf galaxies    | 10^12    | 500.0        |
</details>

Figure 4. Open clusters with $N \star < 2 5 0$ compared to the baryonic Tully-Fisher relation. The error bars indicate the 1 σ spread of the data for each mass bin. The dotted lines are the systematic uncertainty expected due to the presence of unresolved binary contamination, as modelled by HR134. Other data included: galaxy groups (Milgrom 2019; Müller et al. 2022), rotating galaxies (Teodoro et al. 2021; Lelli et al. 2019; McGaugh et al. 2021); dwarf galaxies (McGaugh et al. 2021); weak lensing (Mistele et al. 2024).

It is impressive that taking a sample of Galactic open clusters with a typical mass of a couple hundred stars, this fit should yield a central inferred acceleration scale almost indistinguishable from what results when describing the rotation curves of spiral galaxies.

Comparing Fig. 2 with Fig. 1 under a MOND perspective, we would be forced to conclude that the $N _ { \star } \leq 2 5 0$ population lies in (or retains memory of a formation phase under) the deep-MOND regime, the $2 5 0 < N \star \leq 5 0 0$ population resides within the quasi-Newtonian regime and the $N _ { \star } > 5 0 0$ population probes the forced Newtonian regime, the latter two of which are expressions of the external field effect.

A final test of the emergent deep-MOND character of our $N _ { \star } \leq$ 250 population is explored in Fig. 4, where we plot the mass and geometric equivalent rotation velocities of these clusters, $V _ { c } = \sqrt { 3 } \sigma _ { \star }$ , large blue squares, in comparison, the corresponding values for galactic systems defining the baryonic Tully-Fisher relation. The dotted lines give 500 m/s error ranges on the data presented, where this value represents the expected uncertainty due to the presence of unresolved binaries. While this uncertainty will only result in a possible reduction of the true cluster velocity dispersion, we include it symmetrically as a generous estimate of the systematic error budget of the problem. Under a MOND perspective it has been shown (e.g. McGaugh et al. (2021)), that a conversion factor between line-ofsight velocity dispersion and equivalent BTFR circular velocity of 2.12 rather than 3 is better physically motivated, using this slightly larger factor brings the mean velocity values for the open clusters treated into even better agreement with the galactic BTFR than what is shown in Fig. 4.

We note also that the masses we are using were derived by HR134 through integrating an assumed IMF suitable to the observed stellar population of these clusters. However, no allowance for mass segregation was included, so that if any relevant stellar mass segregation processes have taken place, a systematic error in mass will be introduced. Of course, any such effect is expected to be relevant only for the densest and oldest clusters treated here, and not for the very small and young $N _ { \star } \leq 2 5 0$ objects shown in this figure.

# 5 NEWTONIAN INTERPRETATIONS OF THE SCALING RELATIONS FOUND

The galactic radial acceleration relation and the baryonic Tully-Fisher relation are predictions of MOND for isolated systems which have been confirmed empirically. Under a Newtonian framework, these are interpreted as the presence of a dominant dark matter halo with properties tightly correlated with those of the observed baryonic galaxies. Since the open clusters examined here clearly follow these relations, one possible interpretation for the observed velocity dispersion excess compared to the Newtonian expectation is that the isolated deep-MOND regime is at work.

Before interpreting the data presented as evidence for MOND, we must consider that the excess velocity dispersions of open clusters can also arise from several mechanisms unrelated to modified gravity. It is hence necessary to examine whether observational biases, dynamical misclassification, stellar multiplicity, or the presence of a hypothetical dark matter component could plausibly account for the effect within standard gravitational dynamics. The following subsections assess all these possibilities in turn, focusing on whether they can reproduce not only an overall elevation above the Newtonian virial line, but specifically considering the observed alignment with the radial acceleration relation.

# 5.1 Interloper stars

Cluster membership in the catalogue of HR134 is determined using the HDBSCAN clustering algorithm applied in position–proper motion–parallax space. Only stars with membership probabilities larger than 50% are retained for the computation of mean cluster parameters, and only those lying within a model-independent tidal radius defined via the cluster–field contrast (CST parameter) are included. In addition, stars with $\mathrm { R U W E } > 1 . 4$ are excluded in order to suppress astrometric outliers.

![](images/aa6fedbd2378667c67749fe679e65d64cc66ed2fad5e0faa05acd34b633d12b3.jpg)

<details>
<summary>scatter</summary>

| CMD quality | RAR residuals (dex) |
| ----------- | ------------------- |
| 0.0         | ~0.5                |
| 0.2         | ~0.3                |
| 0.4         | ~0.1                |
| 0.6         | ~0.0                |
| 0.8         | ~-0.2               |
| 1.0         | ~-0.5               |
</details>

![](images/9b8ba17b92e12eca10a1ae6ee942801117d4e84470a3d75da1165114c4eea029.jpg)

<details>
<summary>scatter</summary>

| Fraction of stars in the tidal tail | Value |
| ----------------------------------- | ----- |
| 0.0                                 | 0.0   |
| 0.2                                 | 0.0   |
| 0.4                                 | 0.0   |
| 0.6                                 | 0.0   |
| 0.8                                 | 0.0   |
</details>

![](images/0875fb4c6a8a9e7c3e30269731ef206fc7dd98a00ea4de165d5dc9a4382c61b3.jpg)

<details>
<summary>scatter</summary>

| Ellipticity | c    |
| ----------- | ---- |
| 0.0         | 1.0  |
| 0.2         | 0.0  |
| 0.4         | -1.0 |
| 0.6         | 0.0  |
| 0.8         | 1.0  |
</details>

![](images/f8e9e108e51ed83552c760ff4e5fd1ec2c79928b5eaee35966be498aec96689b.jpg)

<details>
<summary>scatter</summary>

| R_gal (kpc) | RAR residuals (dex) |
| ----------- | ------------------- |
| 6           | ~0                  |
| 8           | ~0                  |
| 10          | ~0                  |
</details>

![](images/99a5679c132c818624308358183976e4ffcdac5e2b5215d2c7759dea2c76f97b.jpg)

![](images/e4d2cbd7a617370fac48e5a1919cbd80a19536113a166280f1bfe631f57ca6f6.jpg)

<details>
<summary>scatter</summary>

| Cluster Age log(yr) | Value |
| ------------------- | ----- |
| 7                   | ~0    |
| 8                   | ~0    |
| 9                   | ~0    |
| 10                  | ~0    |
</details>

Figure 5. Residuals with respect to the radial acceleration relation for our main $N _ { \star } \leq 2 5 0$ open cluster sample, plotted against various independent cluster characteristics.

Recomputing the velocity dispersions using alternative selection criteria, including magnitude cuts and stricter RUWE thresholds, does not significantly change the inferred dispersions. This indicates that contamination by field interlopers is not the dominant driver of the excess velocity dispersion.

If interlopers were responsible for the elevated dispersions, one would expect clusters with cleaner colour–magnitude diagrams to move closer to the Newtonian virial expectation. However, the fiducial high-quality subsample restricted to high CMD quality (> 75%) continues to follow the radial acceleration relation. The systematic alignment of low-??★ clusters with the RAR therefore cannot plausibly be attributed to residual field-star contamination.

This is tested explicitly in Fig. 5 panel a), where we plot the residuals from the best fit RAR as a function of the CMD quality index of the full $N _ { \star } < 2 5 0$ sample. We see that only for the lowest CMD-quality values below 25% a correlation of the residuals to this quantity appears, for all CMD-quality values above 75%, residuals to the best fit RAR are distributed symmetrically about the zero line. No minimum CMD quality threshold will remove the clear RAR scaling reported.

# 5.2 Unresolved binaries

Unresolved binary stars with unequal mass ratios shift the system’s centre of light as the components orbit one another. This motion propagates into the measured velocity dispersion of the cluster, inflating it and biasing virial analyses of open clusters if not properly modelled (Gieles et al. 2010). HR134 attempted to correct for unresolved binaries by adopting mean binary parameters (e.g. period and eccentricity) for field stars from Moe & Stefano (2017) but found this to be impossible. They warn that the velocity dispersions are easily contaminated and that this can contribute $\gtrsim 5 0 0 m s ^ { - 1 }$ . This range is included as the dotted lines in Fig. 4 and corresponds very well to the observed scatter in the data. It is inconsistent as an explanation for the observed trend.

HR134 notes that, for their sample of open clusters, the simulations used to estimate the influence of unresolved binaries may overestimate the effect. Stars likely to be binaries with poor-quality astrometry were already removed by the Rybizki et al. (2022) selection, in addition to the exclusion of stars with RUWE > 1.4 in the velocity dispersion analysis. Indeed, Belokurov et al. (2020) identify this RUWE threshold as a secure limit to exclude unresolved binaries from the Gaia catalogue.

Tightening the RUWE threshold to 1.25 or even 1.0 reduced the inferred cluster velocity dispersions only by about 10%, and does not alter any of the scalings described in the previous section. Nevertheless, the binary fraction may be higher in denser environments such as open clusters. HR134 concludes that a definitive removal of the impact of unresolved binaries on cluster velocity dispersions may not be possible before Gaia DR4, which is expected to provide substantially more non-single-star solutions than Gaia DR3.

Although unresolved binaries cannot presently be ruled out as a systematic leading to the high virial parameters of open clusters, this interpretation appears unlikely as it would not result in the precise RAR and BTFR scalings we obtain. Open clusters with lower internal baryonic accelerations exhibit higher virial parameters; attributing this trend to unresolved binaries would imply that more diffuse clusters host a larger binary fraction, while denser clusters contain fewer binaries. Attributing the scalings described to unresolved binaries would be contrived and require highly fine-tuned unresolved binary parameters to be adjusted as a function of the number of stars and radii of each open cluster, across the cluster population examined.

# 5.3 Dissolution dynamics and tidal heating

One possible explanation for the fact that the sample of HR134 lies above the Newtonian line of virial equilibrium is that these systems are not bound open clusters but unbound associations, since we know that the origin of disc field stars is precisely open cluster dissolution.

Given that the cluster finding algorithm of HR134 does not select over-densities that lack coherent proper motions the sample cannot be comprised of mere chance associations, as clusters are selected on a position-velocity space. However, tidally disrupted formerly bound systems would certainly present a velocity dispersion excess over Newtonian virial expectations. Actually a majority of the open clusters examined do have some tidal features, even if for most these comprise only a small fraction of the stars. In fact, such tidal features themselves offer interesting tests of gravity. Thomas et al. (2018); Kroupa et al. (2022) have shown that tidal tail asymmetries in carefully observed open clusters conflict with Newtonian expectations, while being consistent with MOND expectations. If open clusters are heavily tidally disrupted, it would have to be viewed as an uncanny coincidence that the excess velocities found for the small systems land them on the galactic RAR and BTFR, while then only the more sturdy massive clusters with $N \star \mathrm { ~ > ~ } 5 0 0$ would be gravitationally bound structures.

However, contrary to the above explanation, most systems in the sample are rather spherical and have only a small fraction of stars in what HR134 classifies as a tidal tail, so that tidal disruption does not appear to be a sufficient explanation. This is shown in Fig. 5, panel b), where we plot the residuals from the best fit RAR against the fraction of stars in the tidal tails of the clusters studied. As can be seen, this fraction is smaller than 0.3 for the greater majority of our sample, and for any tidal tail fraction threshold below 0.2, no systematic trend is present, with clusters showing a symmetric residual distribution about zero. Clearly, no tidal tail fraction exclusion criterion will remove the galactic RAR and BTFR scalings we see. Indeed, the distribution of ellipticities of the open clusters defining the galactic scalings mentioned can be seen in Fig. 5, panel c), and shows most are not highly elongated with ellipticities below 0.5, showing no systematic trend of the RAR residuals with this tidally sensitive shape parameter.

Also, if the excess velocity dispersion were caused by tidal disruption by the smooth galactic gravitational field, this would necessitate such an effect to grow with decreasing galactocentric radius, as the galactic tidal field increases with decreasing galactocentric radius. This is not the case, as can be explicitly seen in panel d) of Fig. 5 where the RAR residuals are shown against the galactocentric radii of our open clusters. For any value of this quantity below 10 kpc, residuals show no trend at all and present a symmetric distribution about zero.

Aside from tidal heating from the radial galactic tides, vertical tidal shocking on crossing the midplane of the disc could also be present. This would be more pronounced for the clusters which rise (or dip) most above (or below) the Galactic midplane. Our quality cut at $| Z | < 1 5 0$ pc was explicitly chosen to eliminate this source of excess velocity dispersion. Increasing the severity of this cut to |??| < 100 pc or even $| Z | < 5 0$ pc does not change the fact that $N _ { \star } \leq 2 5 0$ clusters lie along the RAR. As can be seen in panel e) in Fig. 5, no systematic correlation in RAR residuals is seen for any |?? | value below 100 pc, which contains the overwhelming fraction of our sample. Keeping as close to the Galactic midplane as desired preserves the RAR and BTFR scalings.

Interpreting these systems as unbound associations does not explain why they scatter around the two relations predicted by MOND for systems in which the external field is negligible and followed by galactic systems. In principle, unbound stellar associations could occupy any position above the Newtonian virial equilibrium line (dashed line in Fig. 3). It would be a remarkable coincidence if most such associations happened to be observed at precisely the stage in their dissolution at which they acquire the additional dispersion required to lie close to the radial acceleration relation at the time of observation.

Since none of the residuals shown in Fig. 5 show any systematic deviations from the RAR, it appears that the galactic scalings which we have found to apply to these clusters within their tidal radii, are not driven by tidal heating and/or dissolution dynamics.

# 5.4 Dark matter

Since the scalings of the RAR and the BTFR found to describe the clusters treated (within their tidal radii) are interpreted within a galactic standard gravity outlook as reflecting the presence of dominant dark matter halos, it might be tempting to explore such an explanation for the open clusters studied here.

Historically, open clusters have been regarded as systems in which dark matter is negligible. The seminal review on open cluster formation by (Lada & Lada 2003) does not even mention dark matter at all. More recent reviews e.g. (Adamo et al. 2020; Krause et al. 2020) even explicitly define open clusters as systems containing no dark matter. This partly follows from independent bounds on the local dark matter density within the galactic disc. For example, at the Solar Neighbourhood, it is well established that any local dark matter density above 0.01 $M _ { \odot } \mathfrak { p c } ^ { - 3 }$ is excluded by the observed vertical distribution and measured vertical velocities of stars, e.g. Read (2014) found $0 . 0 0 5 < \rho _ { D M } < 0 . 0 1 5$ and more recently using Gaia, Bienaymé et al. (2024) derive $\rho _ { D M } = 0 . 0 1 2 8 \pm 0 . 0 0 0 8$ , both in units of $M _ { \odot } \mathrm { p c } ^ { - 3 }$ , for the Solar Neighbourhood. This value would increase slightly towards the galactic centre, but decrease away, so that on average, the open clusters we examine would be expected to coexist with the smooth Galactic dark matter halo having a density of close to 0.01 $M _ { \odot } \mathrm { p c } ^ { - 3 }$ , at most. Given the scales of our systems of below some 10 pc, within their tidal radii, where we derive the scalings described, they would be expected to contain at most 10 $M _ { \odot }$ of dark matter, which would represent less than some 10% of the cluster’s mass and hence would not explain any velocity boost above a mere 5%.

Aside from the hypothetical smooth dark matter halo component, structure formation simulations predict also the presence of small and dense dark matter sub-halos, e.g. (Springel et al. 2008), which depending on the assumed detailed physics for this component, could extend down to the mass range of open clusters. However, any such hypothetical sub-halos would form part of the overall Galactic dark halo distribution and hence cross the Galactic disc practically vertically at close to the virial velocity of the halo of close to 160 km s−1 $\mathrm { s } ^ { - 1 }$

In fact, such dark matter sub-halos have been envisioned as potential sources of dynamical heating for the Galactic disc e.g. Benson et al. (2004), and would have no chance of serving as seeds of open cluster formation or becoming embedded with the small stellar structures we are examining. We see that the standard explanation within classical gravity for the galactic scalings we have found at open cluster scales, dominant dark matter distributions, has no place at the scales and Galactic disc settings at which we are currently working. Indeed, beyond the continual lack of any dark matter detection, recently Hernandez & Kroupa (2025) have shown that dynamical friction constraints across astronomical scales make the dark matter hypothesis in itself rather dubious.

Finally, the option of the OCs studied having internal dynamics which do not reflect an internal equilibrium dynamical state can also be dismissed. Clusters from the $N _ { \star } \leq 2 5 0$ sample have ages that are much longer than their crossing times. The median age of this sample is 100 million years while the mean crossing time of these clusters are of the order of a million years, see panel f) in Fig. 5.

# 6 MONDIAN INTERPRETATIONS OF THE SCALING RELATIONS FOUND

As explained in section 2.1, under a MOND description, whenever a system having internal accelerations below $a _ { 0 }$ is immersed in an external acceleration field comparable or larger than $^ { a _ { 0 } , }$ MOND effects are suppressed and internally the system behaves in a quasi-Newtonian way. Describing the Galaxy as a purely baryonic system including only the Galactic bulge and a smooth Galactic disc matter distribution, this last typically modelled as a double exponential disc, implies external accelerations at the Solar Radius of slightly above ??0, e.g. Chae (2024a). Thus, the expectation has been for disc open clusters to behave in the quasi-Newtonian regime, and not to present any of the deep-MOND phenomenology associated with the RAR and BTFR galactic scalings. However, the Galactic disc is not in fact a smooth double exponential matter distribution.

Aside from the presence of spiral structure, when looking at recent maps of matter distribution within 3 kpc of the Sun, typically using Gaia data (e.g. Poggio et al. (2021), Zari et al. (2021), Ge et al. (2024)), a strong level of small-scale density fluctuations are apparent. The exact spiral structure of the Milky Way is still uncertain due to observational difficulties arising from our position within the Galaxy (Hou & Han 2014; Xu et al. 2016). However recent measurements using Gaia have enabled mapping the spiral structure in the solar neighbourhood with a resolution of about 300 parsecs (Widmark & Naik 2024). This measurement shows that spiral arms cause $\mathbf { a } ~ \pm 2 0 \%$ density perturbation. Combining the bulge and disc potential of Dehnen & Binney (1998) with the spiral potential of Cox & Gomez (2002) assuming a ±20% density perturbation shows that this alone is incapable of generating the necessary small-scale low-acceleration regions to explain the open cluster data arising from the deep-MOND regime. Smaller scale features such as HI clouds, molecular clouds, tidal streams and open clusters themselves also have their own gravitational fields which can counteract the galactic gravitational field if of sufficient mass and in the right proximity to a region of interest.

To zeroth order, we can calculate from a Newtonian perspective that the 220 km/s of local Galactic rotation at a Galactocentric radius of 8.5 ?? ???? implies a total central mass of $1 0 ^ { 1 1 } M _ { \odot }$ , the resulting gravitational force pointing towards the Galactic centre could then be balanced locally by a $1 0 ^ { 5 } M _ { \odot }$ molecular cloud at a distance of some 10 pc in the direction of the Galactic anti-centre. Thus, it is not impossible, indeed unavoidable, that the inhomogeneities of the small-scale Galactic disc matter distribution will lead to the existence of small scale pockets of overall gravitational potential minima where the external gravitational field will be much smaller than its mean value. Within these pockets, from a MOND perspective, one should expect a much reduced, or even zero EFE, and hence the existence of low internal acceleration systems showing deep-MOND phenomenology.

We propose that small low density gas clouds in the Galactic disc will generally be stable against their internal gravity, being mostly in the EFE dominated regime, but will become gravitationally unstable when entering any gravitational potential minima pockets, where they will find themselves close to the deep-MOND limit. These will then experience star formation and lead to small stellar open clusters with dynamical properties reflecting the BTFR and RAR scalings of galaxies. Indeed, it has long been held that molecular clouds and hence open clusters, form in spiral arm potential minima where material piles up as it passes through the arm on its orbit around the galaxy e.g. (Roberts & Stewart 1987). On leaving these formation pockets small OCs enter again the EFE dominated regime and begin to dissolve into the field. This dissolution process will proceed through tidal effects, which are typically very sensitive to a tidal radius threshold. For example, when describing Roche lobe overflow in tight binary stars, tidal effects are ignored when describing the stellar structure within the Jacobi radius of the star being tidally stripped, while any material beyond this critical radius is lost to the tidal field of the accreting star.

Similarly, the dynamical properties of the small OCs studied here, which closely follow the deep-MOND BTFR and RAR galactic scalings, have been determined exclusively within the tidal radii of each cluster. Stars in the tidal tails have been excluded from the analysis. The dynamics we describe therefore pertain only to the bound (or most nearly bound) inner regions that remain shielded from ongoing tidal stripping, as illustrated in Fig. 5. For the more massive open clusters, the relevant distinction is not that their internal accelerations necessarily exceed $a _ { 0 }$ in isolation, but that the total gravitational field experienced by the system, $g _ { \mathrm { t o t } } \simeq g _ { \mathrm { i n t } } + g _ { \mathrm { e x t } } ,$ , can lie closer to or above $^ { a _ { 0 } , }$ either currently or during formation. In such conditions MOND effects are expected to be strongly suppressed and the internal dynamics to approach the Newtonian virial expectation according to the forced Newtonian regime, with subsequent dissolution and tidal heating capable of driving some systems toward super-virial velocity dispersion values.

If the alignment of open clusters with the RAR and BTFR reflects low-acceleration MOND dynamics within the Galactic disc, this result has consequences that extend beyond cluster kinematics and bear directly on other probes of gravity and on the interpretation of the acceleration scale itself. For example OCs could afford a far stronger EFE test than Chae et al. (2020) if the external field could be quantified. This is because a much larger range of internal and external gravitational fields would be at play.

# 6.1 Mapping the galactic gravitational field

If open cluster velocity dispersions can be measured with improved precision and if some of these systems are confirmed to be in approximate dynamical equilibrium at least within their tidal radii, they could provide an additional method to map the Galactic gravitational field. In the MOND framework, their internal dynamics depend not only on their own baryonic mass distribution but also on the local external field through the external field effect. This introduces an environmental sensitivity that can, in principle, be inverted: given reliable cluster masses and velocity dispersions, the local external acceleration can be constrained. Open clusters would then serve as discrete, parsec-scale probes of the gravitational field within the disc. This approach is complementary to determinations based on the vertical motions of stars in the solar neighbourhood, such as those by Widmark & Naik (2024), which infer the gravitational potential through large-scale kinematic modelling.

# 6.2 Molecular clouds

If the Galactic gravitational field varies on parsec scales and includes regions where the total external gravitational acceleration drops below $^ { a _ { 0 } , }$ molecular clouds can provide an independent test of this hypothesis. As the progenitors of open clusters and systems of comparable mass, they allow the same acceleration-based diagnostics to be applied in the gaseous phase. Modern Galactic cloud catalogues measure cloud sizes, line widths, and distances, permitting estimates of baryonic accelerations from the mass distribution and dynamical accelerations from CO line–derived velocity dispersions. Molecular clouds can therefore be placed in the same acceleration planes as stellar systems and directly compared with Newtonian and MOND expectations.

However, not all molecular clouds are suitable for such an analysis. Surveys that focus on dense cores primarily trace regions already affected by stellar feedback, pressure confinement, and local turbulence, where the dynamics are not dominated solely by self-gravity. At the opposite extreme, giant molecular cloud complexes identified at low angular resolution may blend multiple substructures, obscuring their true dynamical state. Meaningful tests therefore require clouds that are spatially resolved, trace the full extent of the system rather than only its densest parts, and are not strongly perturbed by active star formation. If such systems also exhibit alignment with the RAR or BTFR, this would strengthen the case that low-acceleration regions operate within the Milky Way disc and influence both gaseous and stellar self-gravitating systems.

# 6.3 Wide binaries

Similar to studies of molecular clouds, our current results could also be important to wide binary gravity tests. In these, the relative separations and velocities of wide binary stars are statistically compared to predictions under Newtonian and Milgromian gravity, Hernandez et al. (2012). Since wide binaries experience very low internal gravitational accelerations, they are expected to present a Newtonian gravitational anomaly.

Wide binary gravity tests explicitly exclude any objects being part or close to any stellar over-densities, open clusters or stellar associations, as part of requiring the wide binaries studied to be as isolated from any ambient dynamical perturbations as possible. Further, the clear presence of tidal tails in almost all OCs shows these systems are currently dissolving, under the MOND interpretation presented, we expect them to have been formed in local pockets of low EFE with dynamics which are still reflected in the kinematics of their stars inside their current tidal radii. The OCs’ current positions do not necessarily reflect their initial formation sites a few hundred million years ago. Hence, tracing the regions where OCs show more or less deep-MOND effects will probably not be very relevant to wide binary gravity tests.

However, if the Galactic gravitational field is spatially variable and includes regions where it falls below $^ { a _ { 0 } , }$ , as our current results suggest, then MOND predicts wide binaries to exhibit a substantial range of external field effect strengths. This suggests significant variations in wide binary gravity results might be expected, particularly once observational accuracy increases to the point where these tests can extend beyond the current ∼ 150 pc volume probed, out to kpcscales where a greater range of total gravitational acceleration will be probed.

# 6.4 Acceleration scale convergence

A further consideration concerns the convergence of the acceleration scale ?? across independent empirical domains. As emphasized in philosophical analyses of theory assessment such as Merritt (2020), a parameter that repeatedly emerges from distinct phenomena carries greater evidential weight than one inferred multiple times from essentially the same class of data. Within the Milgromian framework,

Table 1. Determinations of Milgrom’s constant $a _ { 0 } ( 1 0 ^ { - 1 0 } \mathrm { m } \mathrm { s } ^ { - 2 } )$ . 

<table><tr><td>Reference</td><td> $N^{a}$ </td><td> $a_{0}$ </td></tr><tr><td colspan="3">Baryonic Tully-Fisher relation</td></tr><tr><td>Begeman et al. (1991)</td><td>10</td><td> $1.21 \pm 0.24$ </td></tr><tr><td>Stark et al. (2009) $^{e}$ </td><td>28</td><td> $1.18^{d}$ </td></tr><tr><td>Trachternach et al. (2009) $^{e}$ </td><td>34</td><td> $1.30^{d}$ </td></tr><tr><td>McGaugh (2011) $^{e}$ </td><td>47</td><td> $1.24 \pm 0.14$ </td></tr><tr><td>Lelli et al. (2016a)</td><td>118</td><td> $1.29 \pm 0.06^{f}$ </td></tr><tr><td colspan="3">Central surface density relation</td></tr><tr><td>Donato et al. (2009)</td><td> $\sim 10^{3}$ </td><td> $1.3^{g}$ </td></tr><tr><td>Lelli et al. (2016b) $^{h}$ </td><td>135</td><td> $1.27 \pm 0.05^{i}$  $1.27 \pm 0.05^{j}$ </td></tr><tr><td colspan="3">Radial acceleration relation</td></tr><tr><td>Wu &amp; Kroupa (2015)</td><td>74</td><td> $0.94 \pm 0.03^{i}$  $1.21 \pm 0.03^{k}$ </td></tr><tr><td>McGaugh et al. (2016)</td><td>153</td><td> $1.20 \pm 0.02^{l} \pm 0.24^{m}$ </td></tr><tr><td>Lelli et al. (2017)</td><td></td><td></td></tr><tr><td>Open clusters  $N_{\star} \leq 250$ </td><td> $3251^{n}$ </td><td> $\sim 1.4 \pm 0.54 \text{dex}$ </td></tr><tr><td>Open clusters fiducial</td><td> $2423^{n}$ </td><td> $\sim 1.2 \pm 0.52 \text{dex}$ </td></tr></table>

?? Number of galaxies. ?? From McGaugh (2012). ?? Gas-rich galaxies only. ?? Corrected for non-point-mass potential. ?? Based on assumed projected dark matter density. ℎ Least-squares fit to Lelli et al. $( 2 0 1 6 \mathrm { b } ) . \dot { \iota } \ \nu ( \bar { y } )$ with $n = 1$ . $\textit { \textbf { j } } _ { \nu } ( y ) = ( \bar { 1 { \ - } e ^ { - \sqrt { y } } } ) ^ { - 1 } . \bar { \kappa } \ \nu ( y )$ with $n = 2 . ^ { l }$ Random error. ?? Systematic error. ?? Note that individual galaxies are usually measured at 20-50 points along the disc so the total number of data points is actually similar between galaxies and open clusters.

??0 has been recovered from several independent scaling relations, including the baryonic Tully–Fisher relation, the radial acceleration relation, and the central surface density relation. Table 1 reproduces and updates Table 8.1 of Merritt (2020), which is based on different galaxy samples and methodologies and yet cluster around a common value.

The consistency of the best-fit $a _ { 0 }$ obtained from open clusters extends this convergence to a qualitatively different dynamical regime. Open clusters are parsec-scale stellar systems embedded within the Galactic disc and characterised by velocity dispersions rather than rotation curves. Agreement in the inferred acceleration scale across these distinct systems and observables strengthens the interpretation of $a _ { 0 }$ as a genuine dynamical constant rather than a parameter adjusted to fit a particular dataset.

# 7 CONCLUSIONS

We have investigated whether open clusters in the Milky Way follow the radial acceleration relation (RAR) and the baryonic Tully–Fisher relation (BTFR), scaling laws that were originally established for galaxies on kiloparsec scales. Using 3618 Gaia DR3 open clusters from the HR134 catalogue, we computed baryonic and observed accelerations in a manner consistent with Lelli et al. (2017) and placed these systems in the acceleration and mass–velocity planes.

Approximately 90% of open clusters (those with $N _ { \star } \leq 2 5 0 )$ lie close to the RAR, albeit with substantial scatter. A first fit of the RAR to a high-quality subsample yields a best-fit acceleration scale $g _ { \dagger } \approx 1 . 2 \times \mathrm { 1 0 ^ { - 1 0 } m s ^ { - 2 } }$ with an uncertainty of about 0.5 dex. This value is consistent with canonical determinations of $a _ { 0 } ,$ , though far less precise. More massive clusters tend to approach the Newtonian virial expectation, suggesting a transition regime that is qualitatively compatible with an external field contribution. No correlations are present between RAR residuals and galactocentric radius, distance to the Galactic disc midplane, age, ellipticity, tidal tail fraction or cleanliness of the CMD.

Alternative explanations for the elevated velocity dispersions were examined. Interloper contamination and unresolved binaries would increase the inferred stellar velocity dispersions of the OCs explored, but explaining the observed trends would require fine-tuning these effects in a contrived manner. Reclassifying the majority of systems as unbound associations does not naturally explain their concentration along the RAR, since dissolving systems could in principle occupy a broad region above the Newtonian virial line.

If the alignment of most open clusters with the RAR and BTFR reflects MOND low-acceleration dynamics, this implies that parsecscale systems within the Milky Way disc experience gravitational environments that are not adequately described by a spatially smooth field of order $a _ { 0 } .$ . This would indicate that the effective external field varies on small scales, reducing the suppressive impact of the external field effect in some regions. Open clusters would then serve as discrete probes of the Galactic gravitational field on parsec scales.

The consistency of the inferred acceleration scale with values obtained from galaxies extends the convergence of ?? to a distinct dynamical regime characterised by pressure-supported stellar systems embedded within a galactic disc. The quantitative consistency we find between OC properties and the galactic BTFR and RAR scalings motivates improved modelling of cluster masses, velocity dispersions, and the local external field. Higher-resolution studies of the Galactic potential and independent analyses of molecular clouds and wide binaries will be essential to clarify whether the observed behaviour represents a small-scale manifestation of the same acceleration scale that governs galactic dynamics.

# ACKNOWLEDGEMENTS

Gratitude goes to Anthony Brown for comments that helped to understand the systematics of Gaia DR3. X.H. acknowledges financial assistance from SECIHTI SNII and UNAM DGAPA PAPIIT grant IN-102624.

# DATA AVAILABILITY

All data used will be shared upon reasonable request to the authors.

# REFERENCES

Adamo A., et al., 2020, Space Sci. Rev., 216

Banik I., Zhao H., 2022, Symmetry, 14

Begeman K. G., Broeils A. H., Sanders R. H., 1991, MNRAS, 249, 523

Bekenstein J., Milgrom M., 1984, ApJ, 286, 7

Belokurov V., et al., 2020, MNRAS, 496, 1922

Benson A. J., Lacey C. G., Frenk C. S., Baugh C. M., Cole S., 2004, MNRAS, 351, 1215

Bienaymé O., Robin A. C., Salomon J.-B., Reylé C., 2024, A&A, 689, A280

Cantat-Gaudin T., Brandt T. D., 2021, A&A, 649

Casola E. D., Liberati S., Sonego S., 2015, Am. J. Phys., 83, 39

Chae K.-H., 2024a, ApJ, 960, 114

Chae K.-H., 2024b, ApJ, 972, 186

Chae K.-H., Lelli F., Desmond H., McGaugh S. S., Li P., Schombert J. M., 2020, ApJ, 904, 51

Cox D. P., Gomez G. C., 2002, ApJS, 142, 261

Dehnen W., Binney J., 1998, MNRAS, 294, 429

Donato F., et al., 2009, MNRAS, 397, 1169

Famaey B., McGaugh S. S., 2012, Living Rev. Relativ., 15, 10

Ge Q. A., Li J. J., Hao C. J., Lin Z. H., Hou L. G., Liu D. J., Li Y. J., Bian S. B., 2024, AJ, 168, 25

Gieles M., Sana H., Zwart S. F. P., 2010, MNRAS, 402, 1750

Gundlach J. H., Schlamminger S., Spitzer C. D., Choi K. Y., Woodahl B. A., Coy J. J., Fischbach E., 2007, Phys. Rev. Lett., 98

Hernandez X., Kroupa P., 2025, Universe, 11, 367

Hernandez X., Jiménez M. A., Allen C., 2012, Eur. Phys. J. C., 72, 1884

Hernandez X., Verteletskyi V., Nasser L., Aguayo-Ortiz A., 2024, MNRAS, 528, 4720

Hou L. G., Han J. L., 2014, A&A, 569

Hunt E. L., Reffert S., 2021, A&A, 646

Hunt E. L., Reffert S., 2023, A&A, 673

Hunt E. L., Reffert S., 2024, A&A, 686

Klioner S. A., et al., 2021, A&A, 649

Krause M. G., et al., 2020, Space Sci. Rev., 216

Kroupa P., et al., 2022, MNRAS, 517, 3613

Lada C. J., Lada E. A., 2003, ARA&A, 41, 57

Lelli F., McGaugh S. S., Schombert J. M., 2016a, ApJ, 816, L14

Lelli F., McGaugh S. S., Schombert J. M., Pawlowski M. S., 2016b, ApJ, 827, L19

Lelli F., McGaugh S. S., Schombert J. M., Pawlowski M. S., 2017, ApJ, 836, 152

Lelli F., McGaugh S. S., Schombert J. M., Desmond H., Katz H., 2019, MNRAS, 484, 3267

Lindegren L., et al., 2021, A&A, 649

McGaugh S. S., 2011, Phys. Rev. Lett., 106

McGaugh S. S., 2012, AJ, 143

McGaugh S., Milgrom M., 2013a, ApJ, 766

McGaugh S., Milgrom M., 2013b, ApJ, 775

McGaugh S. S., Schombert J. M., Bothun G. D., de Blok W. J. G., 2000, ApJ, 533, L99

McGaugh S. S., Lelli F., Schombert J. M., 2016, Phys. Rev. Lett., 117

McGaugh S. S., Lelli F., Schombert J. M., Li P., Visgaitis T., Parker K. S., Pawlowski M. S., 2021, AJ, 162, 202

Merritt D., 2020, A Philosophical Approach to MOND. Cambridge University Press, doi:10.1017/9781108610926, https://www.cambridge.org/ core/product/identifier/9781108610926/type/book

Milgrom M., 1983a, ApJ, 270, 365

Milgrom M., 1983b, ApJ, 270, 371

Milgrom M., 1983c, ApJ, 270, 384

Milgrom M., 2010, MNRAS, 403, 886

Milgrom M., 2019, Phys. Rev. D, 99

Milgrom M., 2022, Phys. Rev. D, 106, 064060

Mistele T., McGaugh S., Lelli F., Schombert J., Li P., 2024, ApJ, 969, L3

Moe M., Stefano R. D., 2017, ApJS, 230, 55

Müller O., Lelli F., Famaey B., Pawlowski M. S., Fahrion K., Rejkuba M., Hilker M., Jerjen H., 2022, A&A, 662

Poggio E., et al., 2021, A&A, 651, A104

Read J. I., 2014, J. Phys. G, 41, 063101

Roberts William W. J., Stewart G. R., 1987, ApJ, 314, 10

Rybizki J., et al., 2022, MNRAS, 510, 2597

Springel V., et al., 2008, MNRAS, 391, 1685

Stark D. V., McGaugh S. S., Swaters R. A., 2009, AJ, 138, 392

Teodoro E. M. D., Posti L., Ogle P. M., Fall S. M., Jarrett T., 2021, MNRAS, 507, 5820

Thomas G. F., Famaey B., Ibata R., Renaud F., Martin N. F., Kroupa P., 2018, A&A, 609

Trachternach C., Blok W. J. D., McGaugh S. S., Hulst J. M. V. D., Dettmar R. J., 2009, A&A, 505, 577

Widmark A., Naik A. P., 2024, A&A, 686

Wu X., Kroupa P., 2015, MNRAS, 446, 330

Xu Y., et al., 2016, Sci. Adv., 2

Zari E., Rix H.-W., Frankel N., Xiang M., Poggio E., Drimmel R., Tkachenko A., 2021, A&A, 650, A112

Zhang D., Zonoozi A. H., Kroupa P., 2026, Phys. Rev. D, 113, 043027

This paper has been typeset from a TEX/LATEX file prepared by the author.