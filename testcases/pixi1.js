var PIXI = {}

PIXI.Point = function(x, y)
{
    /**
     * @property x 
     * @type Number
     * @default 0
     */
    this.x = x || 0;
    
    /**
     * @property y
     * @type Number
     * @default 0
     */
    this.y = y || 0;
}

PIXI.Polygon = function(points)
{
    //if points isn't an array, use arguments as the array
    if(!(points instanceof Array))
        points = Array.prototype.slice.call(arguments);

    //if this is a flat array of numbers, convert it to points
    if(typeof points[0] === 'number') {
        var p = [];
        for(var i = 0, il = points.length; i < il; i+=2) {
            p.push(
                new PIXI.Point(points[i], points[i + 1])
            );
        }

        points = p;
    }

	this.points = points;
}


function bad() {
    return new Point(1,2);
}
