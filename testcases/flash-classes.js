   

function b2FixtureDef() {
   b2FixtureDef.b2FixtureDef.apply(this, arguments);
   if (this.constructor === b2FixtureDef) this.b2FixtureDef.apply(this, arguments);
};

b2FixtureDef.b2FixtureDef = function () {
   this.filter = {};
};
b2FixtureDef.prototype.b2FixtureDef = function () {
   this.shape = null;
   this.userData = null;
   this.friction = 0.2;
   this.restitution = 0.0;
   this.density = 0.0;
   this.filter.categoryBits = 0x0001;
   this.filter.maskBits = 0xFFFF;
   this.filter.groupIndex = 0;
   this.isSensor = false;
}

var def = new b2FixtureDef();

console.log("def.shape = " + def.shape)

function bad() {
   return new b2FixtureDef().filter.maskBits;
}
