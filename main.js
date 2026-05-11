// TERRITORIO URBANIZADO
var image_2020 = ee.Image("JRC/GHSL/P2023A/GHS_BUILT_S/2025");
var built_2020 = image_2020.select('built_surface');

// DIVISIÓN MUNICIPAL
var municipalities = ['Apodaca']; // Puedes agregar más municipios si deseas
var calculation_area = ee.FeatureCollection("projects/ee-comovamosnl/assets/div-municipal_CF")
  .filter(ee.Filter.inList('NOMGEO', municipalities));

// RASTER DE TEMPERATURA
var temp_collection = ee.ImageCollection('projects/ee-comovamosnl/assets/temp_monthly_2024_NL/temp_montly_NL_corte24-25');
var temperature = temp_collection.mean().rename('temp');
//var temperature = ee.Image('projects/ee-comovamosnl/assets/suhi_raster_celsius')
  //

// Mascara de zonas urbanizadas
var builtUpMask = built_2020.gt(0);
var maskedTemperature = temperature.updateMask(builtUpMask);

// FUNCIÓN: Calcular estadísticas por municipio
var calculateMunicipalStats = function(feature) {
  var municipalityName = feature.get('NOMGEO');

  var stats = maskedTemperature.reduceRegion({
    reducer: ee.Reducer.mean()
      .combine(ee.Reducer.min(), '', true)
      .combine(ee.Reducer.max(), '', true)
      .combine(ee.Reducer.stdDev(), '', true),
    geometry: feature.geometry(),
    scale: 30,
    maxPixels: 1e9
  });

  var meanTemp = stats.get('temp_mean');
  var stdDev = stats.get('temp_stdDev');

  return ee.Algorithms.If(
    ee.Algorithms.IsEqual(meanTemp, null),
    null,
    ee.Algorithms.If(
      ee.Algorithms.IsEqual(stdDev, null),
      null,
      ee.Feature(null, {
        'municipality': municipalityName,
        'mean_temp': meanTemp,
        'min_temp': stats.get('temp_min'),
        'max_temp': stats.get('temp_max'),
        'std_dev': stdDev
      })
    )
  );
};

// Calcular estadísticas por municipio
var municipalStats = calculation_area.map(calculateMunicipalStats)
  .filter(ee.Filter.notNull(['mean_temp', 'std_dev']));

// FUNCIÓN: Clasificar temperatura en categorías
var classifyTemperature = function(feature) {
  var municipalityName = feature.get('municipality');
  var mean = ee.Number(feature.get('mean_temp'));
  var stdDev = ee.Number(feature.get('std_dev'));
  var maxTemp = ee.Number(feature.get('max_temp'));
  var minTemp = ee.Number(feature.get('min_temp'));

  var thresholds = {
    veryHot: mean.add(stdDev.multiply(2)),
    hot: mean.add(stdDev),
    cold: mean.subtract(stdDev),
    veryCold: mean.subtract(stdDev.multiply(2)),
    lowerLimit: minTemp,
    upperLimit: maxTemp
  };

  var municipalityMask = calculation_area
    .filter(ee.Filter.eq('NOMGEO', municipalityName))
    .geometry();

  var classified = maskedTemperature.clip(municipalityMask).expression(
    '(temp >= lowerLimit && temp <= veryCold) ? 0 : ' +
    '(temp > veryCold && temp <= cold) ? 1 : ' +
    '(temp > cold && temp <= hot) ? 2 : ' +
    '(temp > hot && temp <= veryHot) ? 3 : ' +
    '(temp > veryHot && temp <= upperLimit) ? 4 : -1',
    {
      'temp': maskedTemperature.select('temp'),
      'veryCold': thresholds.veryCold,
      'cold': thresholds.cold,
      'hot': thresholds.hot,
      'veryHot': thresholds.veryHot,
      'lowerLimit': thresholds.lowerLimit,
      'upperLimit': thresholds.upperLimit
    }
  );

  classified = classified.updateMask(classified.neq(-1)).clip(municipalityMask);
  return classified;
};

// Aplicar clasificación a cada municipio
var municipalityList = municipalStats.toList(municipalStats.size());
var classifiedTemps = ee.ImageCollection(
  municipalityList.map(function(feature) {
    return classifyTemperature(ee.Feature(feature));
  })
);

// 1. IMPORTAR COORDENADAS DESDE CSV CON TODAS LAS COLUMNAS
var puntosCSV = ee.FeatureCollection("projects/ee-comovamosnl/assets/arboles_eva1/arboles_eva1_apo");

var puntos = puntosCSV.map(function(feature) {
  var lon = ee.Number(feature.get('lon'));
  var lat = ee.Number(feature.get('lat'));
  var point = ee.Geometry.Point([lon, lat]);
  var uid = ee.String(feature.get('id'))
    .cat('_')
    .cat(ee.String(feature.get('periodo')));
  return feature.setGeometry(point).set('system:index', uid);
});

// 2. USAR LA CLASIFICACIÓN FINAL COMO MOSAICO
var clasificacionTemp = classifiedTemps.mosaic().rename('class');

// 3. CLASIFICAR LOS PUNTOS
// Usamos unmask(-1) para conservar los puntos que caen fuera de la zona
// urbanizada (el mapa de calor sólo cubre áreas urbanizadas). Esos puntos
// quedarán en el output con 'class' nulo (sin clasificar).
var puntosClasificados = clasificacionTemp.unmask(-1).sampleRegions({
  collection: puntos,
  scale: 30,
  geometries: true
}).map(function(f) {
  var cls = ee.Number(f.get('class'));
  return f.set('class', ee.Algorithms.If(cls.eq(-1), null, cls));
}).select([
  'id', 'municipio', 'periodo', 'ano', 'mes',
  'cantidad', 'suelo', 'lat', 'lon', 'class'
]);

// 5. EXPORTAR RESULTADO A CSV
Export.table.toDrive({
  collection: puntosClasificados,
  description: 'Validacion_EVA1_APO',
  fileFormat: 'CSV'
});

// 6. VISUALIZACIÓN (opcional)
Map.addLayer(calculation_area, {color: 'grey', fillColor: 'none', opacity: 0.7}, 'Municipios');
Map.addLayer(classifiedTemps, {
  min: 0, max: 4,
  palette: ['blue', 'lightblue', 'yellow', 'orange', 'red'],
  opacity: 0.7
}, 'Clasificación Temp', true);
Map.addLayer(puntosClasificados.style({color: '000000'}), {}, 'Puntos Clasificados');

Map.setCenter(-100.3161, 25.6866, 9);