-- =====================================================================
-- ADIA 0014 - 0013 anadio un parametro con valor por defecto a
-- app.build_silver, lo que CREA UNA SOBRECARGA en vez de reemplazar la
-- funcion. Con las dos vivas, build_silver(bigint) es ambigua:
--   42725 function app.build_silver(bigint) is not unique
-- Se elimina la version de un solo argumento.
-- =====================================================================
drop function if exists app.build_silver(bigint);
