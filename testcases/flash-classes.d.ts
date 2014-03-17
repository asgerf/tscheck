interface b2FilterData {
		/**
		* The collision category bits. Normally you would just set one bit.
		**/
		public categoryBits: number;

		/**
		* Collision groups allow a certain group of objects to never collide (negative) or always collide (positive). Zero means no collision group. Non-zero group filtering always wins against the mask bits.
		**/
		public groupIndex: number;

		/**
		* The collision mask bits. This states the categories that this shape would accept for collision.
		**/
		public maskBits: number;
}
interface ShapeType { x : string }

declare class b2FixtureDef {
	/**
	* The density, usually in kg/m^2.
	**/
	public density: number;

	/**
	* Contact filtering data.
	**/
	public filter: b2FilterData;

	/**
	* The friction coefficient, usually in the range [0,1].
	**/
	public friction: number;

	/**
	* A sensor shape collects contact information but never generates a collision response.
	**/
	public isSensor: boolean;

	/**
	* The restitution (elasticity) usually in the range [0,1].
	**/
	public restitution: number;

	/**
	* The shape, this must be set. The shape will be cloned, so you can create the shape on the stack.
	**/
	public shape: ShapeType;

	/**
	* Use this to store application specific fixture data.
	**/
	public userData: any;

	/**
	* The constructor sets the default fixture definition values.
	**/
	constructor();
}

declare function bad(): string;
