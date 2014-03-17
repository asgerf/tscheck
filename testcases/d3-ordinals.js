var d3 = {
  scale: {}
}


function d3_rgbNumber(value) {
  return d3_rgb(value >> 16, value >> 8 & 255, value & 255);
}
function d3_rgbString(value) {
  return d3_rgbNumber(value) + "";
}
function d3_rgb(r, g, b) {
  return new d3_Rgb(r, g, b);
}
function d3_Rgb(r, g, b) {
  this.r = r;
  this.g = g;
  this.b = b;
}

d3.scale.ordinal = function() {
  return d3_scale_ordinal([], {
    t: "range",
    a: [ [] ]
  });
};
function d3_scale_ordinal(domain, ranger) {
  var index, range, rangeBand;
  function scale(x) {
    return range[((index.get(x) || ranger.t === "range" && index.set(x, domain.push(x))) - 1) % range.length];
  }
  function steps(start, step) {
    return d3.range(domain.length).map(function(i) {
      return start + step * i;
    });
  }
  scale.domain = function(x) {
    if (!arguments.length) return domain;
    domain = [];
    index = new d3_Map();
    var i = -1, n = x.length, xi;
    while (++i < n) if (!index.has(xi = x[i])) index.set(xi, domain.push(xi));
    return scale['range'].apply();
    // return scale[ranger.t].apply(scale, ranger.a);
  };
  scale.range = function(x) {
    if (!arguments.length) return range;
    range = x;
    rangeBand = 0;
    ranger = {
      t: "range",
      a: arguments
    };
    return scale;
  };
  scale.rangePoints = function(x, padding) {
    if (arguments.length < 2) padding = 0;
    var start = x[0], stop = x[1], step = (stop - start) / (Math.max(1, domain.length - 1) + padding);
    range = steps(domain.length < 2 ? (start + stop) / 2 : start + step * padding / 2, step);
    rangeBand = 0;
    ranger = {
      t: "rangePoints",
      a: arguments
    };
    return scale;
  };
  scale.rangeBands = function(x, padding, outerPadding) {
    if (arguments.length < 2) padding = 0;
    if (arguments.length < 3) outerPadding = padding;
    var reverse = x[1] < x[0], start = x[reverse - 0], stop = x[1 - reverse], step = (stop - start) / (domain.length - padding + 2 * outerPadding);
    range = steps(start + step * outerPadding, step);
    if (reverse) range.reverse();
    rangeBand = step * (1 - padding);
    ranger = {
      t: "rangeBands",
      a: arguments
    };
    return scale;
  };
  scale.rangeRoundBands = function(x, padding, outerPadding) {
    if (arguments.length < 2) padding = 0;
    if (arguments.length < 3) outerPadding = padding;
    var reverse = x[1] < x[0], start = x[reverse - 0], stop = x[1 - reverse], step = Math.floor((stop - start) / (domain.length - padding + 2 * outerPadding)), error = stop - start - (domain.length - padding) * step;
    range = steps(start + Math.round(error / 2), step);
    if (reverse) range.reverse();
    rangeBand = Math.round(step * (1 - padding));
    ranger = {
      t: "rangeRoundBands",
      a: arguments
    };
    return scale;
  };
  scale.rangeBand = function() {
    return rangeBand;
  };
  scale.copy = function() {
    return d3_scale_ordinal(domain, ranger);
  };
  return scale.domain(domain);
}
d3.scale.category10 = function() {
  return d3.scale.ordinal().range(d3_category10);
};
d3.scale.category20 = function() {
  return d3.scale.ordinal().range(d3_category20);
};
d3.scale.category20b = function() {
  return d3.scale.ordinal().range(d3_category20b);
};
d3.scale.category20c = function() {
  return d3.scale.ordinal().range(d3_category20c);
};
var d3_category10 = [ 2062260, 16744206, 2924588, 14034728, 9725885, 9197131, 14907330, 8355711, 12369186, 1556175 ].map(d3_rgbString);
var d3_category20 = [ 2062260, 11454440, 16744206, 16759672, 2924588, 10018698, 14034728, 16750742, 9725885, 12955861, 9197131, 12885140, 14907330, 16234194, 8355711, 13092807, 12369186, 14408589, 1556175, 10410725 ].map(d3_rgbString);
var d3_category20b = [ 3750777, 5395619, 7040719, 10264286, 6519097, 9216594, 11915115, 13556636, 9202993, 12426809, 15186514, 15190932, 8666169, 11356490, 14049643, 15177372, 8077683, 10834324, 13528509, 14589654 ].map(d3_rgbString);
var d3_category20c = [ 3244733, 7057110, 10406625, 13032431, 15095053, 16616764, 16625259, 16634018, 3253076, 7652470, 10607003, 13101504, 7695281, 10394312, 12369372, 14342891, 6513507, 9868950, 12434877, 14277081 ].map(d3_rgbString);
