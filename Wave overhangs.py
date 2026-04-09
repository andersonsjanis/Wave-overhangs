"""
Wavefront filling inside a boundary polygon using a Huygens-inspired propagation rule.

Dependencies:
    pip install shapely matplotlib

What this script does:
- Starts from a seed LineString W0
- Samples points along the current wavefront
- Places circles of radius = wavelength at those points
- Unions those circles
- Clips the result to the boundary polygon
- Removes backward propagation by subtracting the previous wavefront
- Repeats until no meaningful new wavefront is produced or iteration limit is reached

Notes:
- The implementation is structured so future support for polygon seeds is straightforward.
- The generated wavefronts may be line or area geometries depending on the step.
- For line-type wavefronts, a very small buffer is used when a difference operation requires an area.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Sequence, Tuple

import matplotlib.pyplot as plt
from shapely.geometry import (
    GeometryCollection,
    LineString,
    MultiLineString,
    MultiPolygon,
    Point,
    Polygon,
)
from shapely.ops import unary_union

Coordinate = Tuple[float, float]


# -----------------------------------------------------------------------------
# Configuration / data container
# -----------------------------------------------------------------------------

@dataclass
class PropagationParams:
    wavelength: float
    discretization_distance: float
    iteration_limit: int
    min_new_area: float = 1e-6
    line_buffer_eps: float = 1e-6
    circle_resolution: int = 32  # controls smoothness of circle approximation


# -----------------------------------------------------------------------------
# Geometry creation and validation
# -----------------------------------------------------------------------------

def make_boundary_polygon(coords: Sequence[Coordinate]) -> Polygon:
    """
    Create and sanitize a boundary polygon from coordinate tuples.

    If the polygon is invalid (e.g. self-intersecting), buffer(0) is used as a
    common repair heuristic.
    """
    poly = Polygon(coords)
    if poly.is_empty:
        raise ValueError("Boundary polygon is empty.")

    if not poly.is_valid:
        poly = poly.buffer(0)

    if poly.is_empty or not poly.is_valid:
        raise ValueError("Boundary polygon is invalid and could not be repaired.")

    if poly.area <= 0:
        raise ValueError("Boundary polygon has zero area.")

    return poly


def make_seed_linestring(coords: Sequence[Coordinate]) -> LineString:
    """
    Create and validate the seed LineString.
    """
    if len(coords) < 2:
        raise ValueError("Seed LineString requires at least two points.")

    line = LineString(coords)

    if line.is_empty:
        raise ValueError("Seed LineString is empty.")

    if not line.is_valid:
        line = line.buffer(0)

    # If buffer(0) turned it into a non-line geometry, reject it for now.
    if line.is_empty or not hasattr(line, "geom_type"):
        raise ValueError("Seed LineString is invalid and could not be repaired.")

    if line.length == 0:
        raise ValueError("Seed LineString has zero length.")

    if line.geom_type != "LineString":
        raise ValueError(
            f"Seed geometry repair produced {line.geom_type}; "
            "this version expects a LineString seed."
        )

    return line


# -----------------------------------------------------------------------------
# Geometry helpers
# -----------------------------------------------------------------------------

def to_emitter_lines(geom):
    """
    Convert a geometry into line-like geometry that can emit the next wavefront.

    Current behavior:
    - LineString / MultiLineString: use directly
    - Polygon / MultiPolygon: use boundaries
    - GeometryCollection: collect supported parts recursively

    This is the main hook that makes future polygon-seed support straightforward.
    """
    if geom.is_empty:
        return GeometryCollection()

    gt = geom.geom_type

    if gt == "LineString" or gt == "MultiLineString":
        return geom

    if gt == "Polygon":
        return geom.boundary

    if gt == "MultiPolygon":
        return MultiLineString([poly.exterior.coords for poly in geom.geoms])

    if gt == "GeometryCollection":
        parts = []
        for g in geom.geoms:
            emitter = to_emitter_lines(g)
            if not emitter.is_empty:
                parts.append(emitter)
        if not parts:
            return GeometryCollection()
        return unary_union(parts)

    return GeometryCollection()


def iter_lines(geom) -> Iterable[LineString]:
    """
    Yield LineString objects from supported line-like geometries.
    """
    if geom.is_empty:
        return

    if geom.geom_type == "LineString":
        yield geom
    elif geom.geom_type == "MultiLineString":
        for line in geom.geoms:
            yield line
    elif geom.geom_type == "GeometryCollection":
        for g in geom.geoms:
            yield from iter_lines(g)


def sample_points_along_lines(geom, spacing: float) -> List[Point]:
    """
    Sample points along a line or collection of lines so that adjacent points are
    approximately 'spacing' apart.

    Endpoints are always included.
    """
    if spacing <= 0:
        raise ValueError("Discretization distance must be > 0.")

    points: List[Point] = []

    for line in iter_lines(geom):
        length = line.length
        if length == 0:
            continue

        n_steps = max(1, int(round(length / spacing)))

        # Include both endpoints
        for i in range(n_steps + 1):
            d = min(i * spacing, length)
            points.append(line.interpolate(d))

        # Ensure final endpoint is included exactly
        if points and points[-1].distance(Point(line.coords[-1])) > 1e-12:
            points.append(Point(line.coords[-1]))

    return points


def geometry_area_like(geom, line_buffer_eps: float) -> Polygon | MultiPolygon:
    """
    Convert geometry into an area-like geometry suitable for difference operations.

    - Polygon / MultiPolygon: returned as-is
    - LineString / MultiLineString: buffered very slightly
    """
    if geom.is_empty:
        return geom

    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom

    if geom.geom_type in ("LineString", "MultiLineString"):
        return geom.buffer(line_buffer_eps)

    if geom.geom_type == "GeometryCollection":
        parts = [geometry_area_like(g, line_buffer_eps) for g in geom.geoms if not g.is_empty]
        if not parts:
            return GeometryCollection()
        return unary_union(parts)

    return geom.buffer(line_buffer_eps)


def significant_new_geometry(new_geom, old_union, min_area: float, line_buffer_eps: float) -> bool:
    """
    Check whether new geometry contributes meaningful new area beyond what already exists.
    """
    new_area_like = geometry_area_like(new_geom, line_buffer_eps)
    old_area_like = geometry_area_like(old_union, line_buffer_eps)

    delta = new_area_like.difference(old_area_like)
    return not delta.is_empty and delta.area > min_area


# -----------------------------------------------------------------------------
# Core propagation
# -----------------------------------------------------------------------------

def propagate_one_step(
    current_wavefront,
    previous_wavefront,
    boundary: Polygon,
    params: PropagationParams,
):
    """
    Perform one propagation step.

    Steps:
    1. Convert current wavefront to emitter lines
    2. Sample points along those lines
    3. Create circles around the points
    4. Union all circles
    5. Clip to boundary
    6. Subtract previous wavefront to suppress backward propagation
    """
    emitter = to_emitter_lines(current_wavefront)
    if emitter.is_empty:
        return GeometryCollection()

    points = sample_points_along_lines(emitter, params.discretization_distance)
    if not points:
        return GeometryCollection()

    circles = [
        pt.buffer(params.wavelength, resolution=params.circle_resolution)
        for pt in points
    ]
    propagated_region = unary_union(circles)

    # Keep only the part inside the boundary
    propagated_region = propagated_region.intersection(boundary)

    # Remove backward propagation by subtracting previous wavefront
    previous_area_like = geometry_area_like(previous_wavefront, params.line_buffer_eps)
    forward_only = propagated_region.difference(previous_area_like)

    # Clean numerical artifacts
    if not forward_only.is_valid:
        forward_only = forward_only.buffer(0)

    return forward_only


def generate_wavefronts(
    boundary_coords: Sequence[Coordinate],
    seed_coords: Sequence[Coordinate],
    params: PropagationParams,
):
    """
    Generate wavefronts [W0, W1, ..., Wn].

    W0 is the seed LineString.
    Each next wavefront is created by one propagation step.
    """
    boundary = make_boundary_polygon(boundary_coords)
    seed = make_seed_linestring(seed_coords)

    # Optional clipping if the seed is partially outside the boundary
    seed = seed.intersection(boundary)

    if seed.is_empty:
        print("Warning: seed lies completely outside the boundary. No propagation possible.")
        return boundary, []

    wavefronts = [seed]

    # Used to detect whether a new wavefront adds meaningful new area
    accumulated = geometry_area_like(seed, params.line_buffer_eps)

    current = seed
    previous = seed

    for iteration in range(params.iteration_limit):
        new_wavefront = propagate_one_step(
            current_wavefront=current,
            previous_wavefront=previous,
            boundary=boundary,
            params=params,
        )

        if new_wavefront.is_empty:
            print(f"Stopping at iteration {iteration + 1}: empty wavefront.")
            break

        if not significant_new_geometry(
            new_geom=new_wavefront,
            old_union=accumulated,
            min_area=params.min_new_area,
            line_buffer_eps=params.line_buffer_eps,
        ):
            print(f"Stopping at iteration {iteration + 1}: no significant new area.")
            break

        wavefronts.append(new_wavefront)
        accumulated = unary_union([accumulated, geometry_area_like(new_wavefront, params.line_buffer_eps)])

        previous = current
        current = new_wavefront

    return boundary, wavefronts


# -----------------------------------------------------------------------------
# Plotting
# -----------------------------------------------------------------------------

def plot_geometry(ax, geom, color="blue", linewidth=1.5, alpha=0.4, fill=False, label=None):
    """
    Plot a shapely geometry on a matplotlib axis.
    """
    if geom.is_empty:
        return

    gt = geom.geom_type

    if gt == "LineString":
        x, y = geom.xy
        ax.plot(x, y, color=color, linewidth=linewidth, label=label)
        return

    if gt == "MultiLineString":
        first = True
        for line in geom.geoms:
            plot_geometry(
                ax, line, color=color, linewidth=linewidth, alpha=alpha,
                fill=fill, label=label if first else None
            )
            first = False
        return

    if gt == "Polygon":
        x, y = geom.exterior.xy
        if fill:
            ax.fill(x, y, color=color, alpha=alpha, label=label)
            ax.plot(x, y, color=color, linewidth=linewidth)
        else:
            ax.plot(x, y, color=color, linewidth=linewidth, label=label)

        # Draw holes if present
        for interior in geom.interiors:
            xi, yi = interior.xy
            ax.plot(xi, yi, color=color, linewidth=linewidth)
        return

    if gt == "MultiPolygon":
        first = True
        for poly in geom.geoms:
            plot_geometry(
                ax, poly, color=color, linewidth=linewidth, alpha=alpha,
                fill=fill, label=label if first else None
            )
            first = False
        return

    if gt == "GeometryCollection":
        first = True
        for g in geom.geoms:
            plot_geometry(
                ax, g, color=color, linewidth=linewidth, alpha=alpha,
                fill=fill, label=label if first else None
            )
            first = False
        return


def plot_wavefronts(boundary: Polygon, wavefronts: List):
    """
    Plot boundary, seed, and generated wavefronts.
    """
    fig, ax = plt.subplots(figsize=(8, 8))

    # Boundary
    plot_geometry(ax, boundary, color="black", linewidth=2.0, fill=False, label="Boundary")

    if not wavefronts:
        ax.set_title("No wavefronts generated")
        ax.set_aspect("equal")
        plt.show()
        return

    # Seed
    plot_geometry(ax, wavefronts[0], color="red", linewidth=2.5, fill=False, label="Seed (W0)")

    # Generated wavefronts
    for i, wf in enumerate(wavefronts[1:], start=1):
        plot_geometry(
            ax,
            wf,
            color="royalblue",
            linewidth=1.2,
            alpha=0.25,
            fill=True,
            label="Wavefronts" if i == 1 else None,
        )

    ax.set_aspect("equal", adjustable="box")
    ax.set_title("Wavefront propagation inside boundary")
    ax.legend()
    ax.grid(True, linestyle="--", alpha=0.3)
    plt.show()


# -----------------------------------------------------------------------------
# Minimal working example
# -----------------------------------------------------------------------------

def main():
    # Example boundary polygon
    boundary_coords = [
        (0.0, 0.0),
        (12.0, 0.0),
        (12.0, 8.0),
        (8.0, 10.0),
        (4.0, 9.0),
        (0.0, 6.0),
        (0.0, 0.0),
    ]

    # Example seed line
    seed_coords = [
        (12.0, 8.0),
        (8.0, 10.0),
    ]
    
    
    # Example seed line
    #seed_coords = [
    #    (1.0, 1.5),
    #    (3.5, 2.0),
    #    (5.5, 2.2),
    #]
    
    

    params = PropagationParams(
        wavelength=0.7,
        discretization_distance=0.35,
        iteration_limit=20,
        min_new_area=1e-4,
        line_buffer_eps=1e-5,
        circle_resolution=24,
    )

    boundary, wavefronts = generate_wavefronts(
        boundary_coords=boundary_coords,
        seed_coords=seed_coords,
        params=params,
    )

    print(f"Generated {len(wavefronts)} wavefront geometries (including W0).")
    for i, wf in enumerate(wavefronts):
        print(f"W_{i}: {wf.geom_type}")

    plot_wavefronts(boundary, wavefronts)


if __name__ == "__main__":
    main()