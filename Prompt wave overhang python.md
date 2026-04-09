Write a Python script that generates paths which fill a boundary area using a wavefront propagation method inspired by Huygens' principle.

GOAL:
Simulate wavefront propagation starting from a seed geometry and iteratively fill a boundary polygon.

INPUT:
- Boundary geometry:
  A closed polygon defined as an ordered list of (x, y) coordinate tuples.

- Seed geometry:
  A LineString defined as an ordered list of (x, y) coordinate tuples.
  (For now, assume the seed is always a line, but structure the implementation so that supporting polygon seed geometries in a future version would be straightforward.)

- Wavelength:
  Float. Used as the radius of the propagation circles.

- Discretization distance:
  Float. Distance used to subdivide the wavefront into points.

- Iteration limit:
  Integer. Maximum number of propagation steps.

EXPLANATION:
The boundary area is filled with paths that emanate from the seed geometry like waves, according to a Huygens-style wave propagation heuristic.

DEFINITIONS:
- W_i denotes the wavefront at iteration i.
- W_0 is the seed geometry.
- A wavefront is represented as a geometry that can be used to generate the next wavefront.
- Boolean operations refer to standard geometric operations such as union, intersection, and difference.

ALGORITHM:

1. Initialization:
   - Set W_0 equal to the seed geometry.

2. Iterative propagation:
   For each iteration i:

   a. Take the current wavefront W_i.

   b. Subdivide W_i into a sequence of points such that the distance between consecutive points is approximately equal to the discretization distance.

   c. For each point, construct a circle with radius = wavelength.

   d. Compute the union of all circles.
      - This produces a highly overlapping, sausage-like closed geometry representing the propagated region.

   e. Intersect this geometry with the boundary polygon so that only the portion inside the boundary remains.

   f. Remove backward propagation:
      - Subtract the previous wavefront W_(i-1) from the result using a geometric difference operation.
      - This should isolate only the forward-propagating portion of the new wavefront.

   g. The resulting geometry is W_(i+1).

3. Termination conditions:
   Stop when either:
   - The iteration limit is reached, OR
   - No new wavefront can be constructed, meaning W_(i+1) is empty or adds no significant new area.

OUTPUT:
- A list of wavefront geometries: [W_0, W_1, ..., W_n]
- A final plot created with matplotlib showing:
  - the boundary polygon in one color
  - the seed geometry in a second color
  - the generated wavefronts in a third color

EDGE CASES:
- Seed geometry lies partially or completely outside the boundary
- Invalid or self-intersecting geometries
- Very small discretization distance leading to high computation cost
- Degenerate cases where no forward propagation is possible

STYLE REQUIREMENTS:
- Modular code with clear function separation
- Readable and maintainable structure
- Inline comments explaining each step of the algorithm

EXTRAS:
- Include a minimal working example with sample input data
- Use matplotlib to display the result directly