import * as THREE from "three";

export interface ProjectionCaptureActorOptions {
  center: THREE.Vector3;
  surfaceNormal: THREE.Vector3;
  width: number;
  height: number;
  near: number;
  far: number;
}

/**
 * DCC-style transformable orthographic projector used by capture and decals.
 *
 * Local -Z is the projection direction. The line box is deliberately custom
 * instead of CameraHelper so near/far planes remain easy to read and can later
 * be reused by the Decal actor without pulling camera-specific visuals along.
 */
export class ProjectionCaptureActor {
  readonly root = new THREE.Group();
  readonly camera: THREE.OrthographicCamera;
  readonly gizmo: THREE.LineSegments;

  private width: number;
  private height: number;
  private near: number;
  private far: number;

  constructor(options: ProjectionCaptureActorOptions) {
    this.width = Math.max(options.width, 0.001);
    this.height = Math.max(options.height, 0.001);
    this.near = Math.max(options.near, 0.001);
    this.far = Math.max(options.far, this.near + 0.001);

    this.root.name = "ProjectionCaptureActor";
    this.root.position.copy(options.center);
    const normal = options.surfaceNormal.clone().normalize();
    if (normal.lengthSq() < 0.5) normal.set(0, 0, 1);
    // A Three.js camera looks down local -Z; aligning local +Z to the surface
    // normal makes the actor look back toward the selected surface.
    this.root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);

    this.camera = new THREE.OrthographicCamera(
      -this.width * 0.5,
      this.width * 0.5,
      this.height * 0.5,
      -this.height * 0.5,
      this.near,
      this.far,
    );
    this.camera.name = "ProjectionCaptureCamera";
    this.root.add(this.camera);

    this.gizmo = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: 0x69dcff,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        toneMapped: false,
      }),
    );
    this.gizmo.name = "ProjectionCaptureGizmoBox";
    this.gizmo.renderOrder = 10_000;
    this.root.add(this.gizmo);
    this.updateProjection();
  }

  getWidth(): number { return this.width; }
  getHeight(): number { return this.height; }
  getNear(): number { return this.near; }
  getFar(): number { return this.far; }

  setClipPlanes(near: number, far: number): void {
    this.near = Math.max(near, 0.001);
    this.far = Math.max(far, this.near + 0.001);
    this.updateProjection();
  }

  /**
   * Converts a completed TransformControls scale gesture into projector size.
   * Keeping root scale at one prevents a scaled parent from corrupting the
   * camera view matrix while still providing familiar DCC scale handles.
   */
  absorbRootScale(): void {
    const scale = this.root.scale;
    this.width = Math.max(this.width * Math.abs(scale.x), 0.001);
    this.height = Math.max(this.height * Math.abs(scale.y), 0.001);
    const depthScale = Math.max(Math.abs(scale.z), 0.001);
    this.near = Math.max(this.near * depthScale, 0.001);
    this.far = Math.max(this.far * depthScale, this.near + 0.001);
    scale.set(1, 1, 1);
    this.updateProjection();
  }

  setGizmoVisible(visible: boolean): void {
    this.gizmo.visible = visible;
  }

  dispose(): void {
    this.gizmo.geometry.dispose();
    const material = this.gizmo.material;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material.dispose();
    this.root.removeFromParent();
  }

  private updateProjection(): void {
    this.camera.left = -this.width * 0.5;
    this.camera.right = this.width * 0.5;
    this.camera.top = this.height * 0.5;
    this.camera.bottom = -this.height * 0.5;
    this.camera.near = this.near;
    this.camera.far = this.far;
    this.camera.updateProjectionMatrix();
    this.updateGizmoGeometry();
  }

  private updateGizmoGeometry(): void {
    const x = this.width * 0.5;
    const y = this.height * 0.5;
    const nearZ = -this.near;
    const farZ = -this.far;
    const corners = [
      new THREE.Vector3(-x, -y, nearZ),
      new THREE.Vector3(x, -y, nearZ),
      new THREE.Vector3(x, y, nearZ),
      new THREE.Vector3(-x, y, nearZ),
      new THREE.Vector3(-x, -y, farZ),
      new THREE.Vector3(x, -y, farZ),
      new THREE.Vector3(x, y, farZ),
      new THREE.Vector3(-x, y, farZ),
    ];
    const edgeIndices = [
      0, 1, 1, 2, 2, 3, 3, 0,
      4, 5, 5, 6, 6, 7, 7, 4,
      0, 4, 1, 5, 2, 6, 3, 7,
    ];
    const positions: number[] = [];
    for (const index of edgeIndices) positions.push(...corners[index].toArray());
    // Direction line from the actor origin to the center of the far plane.
    positions.push(0, 0, 0, 0, 0, farZ);
    this.gizmo.geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    this.gizmo.geometry.computeBoundingSphere();
  }
}
