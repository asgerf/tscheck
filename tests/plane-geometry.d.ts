module THREE {

    export class Vector2 {

        constructor(x?: number, y?: number);

        x: number;

        y: number;
    }

    export class PlaneGeometry  {
        constructor(width: number, height: number, widthSegments?: number, heightSegments?: number);
        faceVertexUvs: Vector2[][];
    }
}
