
  function d3_functor(v) {
    return typeof v === "function" ? v : function() {
      return v;
    };
  }

  var good = d3_functor;
  var bad = 4;