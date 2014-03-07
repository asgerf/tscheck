(function (root, factory) {  // Universal Module Definition (https://github.com/umdjs/umd)
    if (typeof exports === 'object') {
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        define(factory);
    } else {
        root.SMap = factory();
  }
}(this, function () {
    
function SMap() {
    this.size = 0
}
SMap.prototype.put = function(key, val) {
    key = '$' + key
    if (!(key in this))
        this.size++
    this[key] = val;
};
SMap.prototype.get = function(key) {
    return this['$' + key];
};
SMap.prototype.has = function(key) {
    return ('$' + key) in this
};
SMap.prototype.remove = function(key) {
    key = '$' + key
    if (key in this) {
        this.size--
        delete this[key] // note: return value of delete appears to be unreliable
    }
};
SMap.prototype.forEach = function(callback) {
    for (var k in this) {
        if (k[0] !== '$') {
            continue;
        }
        callback(k.substring(1), this[k]);
    }
};
SMap.prototype.map = function(callback) {
    var result = new SMap;
    for (var k in this) {
        if (k[0] !== '$') {
            continue;
        }
        result[k] = callback(k.substring(1), this[k]);
    }
    result.size = this.size
    return result
}
SMap.prototype.mapUpdate = function(callback) {
    for (var k in this) {
        if (k[0] !== '$') {
            continue;
        }
        this[k] = callback(k.substring(1), this[k]);
    }
}
SMap.prototype.mapv = function(callback) {
    var result = new SMap;
    for (var k in this) {
        if (k[0] !== '$') {
            continue;
        }
        result[k] = callback(this[k]);
    }
    result.size = this.size
    return result
}
SMap.prototype.clone = function() {
    var result = new SMap
    for (var k in this) {
        if (k[0] !== '$') {
            continue;
        }
        result[k] = this[k]
    }
    result.size = this.size
    return result
}
SMap.prototype.json = function() {
    var result = {}
    for (var k in this) {
        if (k[0] !== '$')
            continue;
        var key = k.substring(1)
        result[key] = this[k]
    }
    return result;
}
SMap.prototype.keys = function() {
    var result = []
    for (var k in this) {
        if (k[0] !== '$')
            continue;
        result.push(k.substring(1))
    }
    return result
}

// Specialized methods
SMap.prototype.push = function(key, val) {
    key = '$' + key
    if (!(key in this)) {
        this[key] = [];
        this.size++
    }
    this[key].push(val);
};
SMap.prototype.increment = function(key, val) {
    key = '$' + key
    if (!(key in this)) {
        this[key] = 0;
        this.size++
    }
    if (typeof val === 'undefined')
        val = 1;
    this[key] += val;
};
SMap.groupBy = function(list, item2key) {
    if (typeof item2key === 'string') {
        var prty = item2key;
        item2key = function(item) {
             return item[prty];
        };
    }
    var map = new SMap;
    for (var i=0; i<list.length; i++) {
        map.push(item2key(list[i]), list[i]);
    }
    return map;
};
    
return SMap

})); // end of UMD
