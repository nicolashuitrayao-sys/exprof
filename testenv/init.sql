IF DB_ID('ExprofTest') IS NULL CREATE DATABASE ExprofTest;
GO
USE ExprofTest;
GO
IF OBJECT_ID('dbo.Pedidos') IS NOT NULL DROP TABLE dbo.Pedidos;
IF OBJECT_ID('dbo.Clientes') IS NOT NULL DROP TABLE dbo.Clientes;
CREATE TABLE dbo.Clientes (Id INT IDENTITY PRIMARY KEY, Nombre NVARCHAR(100) NOT NULL, Ciudad NVARCHAR(60));
CREATE TABLE dbo.Pedidos (Id INT IDENTITY PRIMARY KEY, ClienteId INT NOT NULL REFERENCES dbo.Clientes(Id), Monto DECIMAL(12,2) NOT NULL, Fecha DATETIME2 DEFAULT SYSDATETIME());
INSERT dbo.Clientes(Nombre,Ciudad) VALUES (N'Cliente Demo 1',N'Santiago'),(N'Cliente Demo 2',N'Valparaiso'),(N'Cliente Demo 3',N'Concepcion');
INSERT dbo.Pedidos(ClienteId,Monto) VALUES (1,1000),(1,2500),(2,700),(3,12000);
GO
CREATE OR ALTER PROCEDURE dbo.usp_ListarClientes AS SELECT Id,Nombre,Ciudad FROM dbo.Clientes;
GO
CREATE OR ALTER PROCEDURE dbo.usp_ObtenerPedidosCliente @ClienteId INT AS
  SELECT Id,Monto,Fecha FROM dbo.Pedidos WHERE ClienteId=@ClienteId;
GO
CREATE OR ALTER PROCEDURE dbo.usp_CalcularTotal @ClienteId INT, @Total DECIMAL(14,2) OUTPUT AS
  SELECT @Total = ISNULL(SUM(Monto),0) FROM dbo.Pedidos WHERE ClienteId=@ClienteId;
GO
CREATE OR ALTER PROCEDURE dbo.usp_ResumenVentas AS
BEGIN
  DECLARE @t DECIMAL(14,2), @i INT = 1;
  WHILE @i <= 3 BEGIN EXEC dbo.usp_CalcularTotal @i, @t OUTPUT; SET @i += 1; END
  WAITFOR DELAY '00:00:00.150';
  SELECT c.Nombre, SUM(p.Monto) Total FROM dbo.Clientes c JOIN dbo.Pedidos p ON p.ClienteId=c.Id GROUP BY c.Nombre;
END
GO
CREATE OR ALTER PROCEDURE dbo.usp_RegistrarPedido @ClienteId INT, @Monto DECIMAL(12,2) AS
  INSERT dbo.Pedidos(ClienteId,Monto) VALUES(@ClienteId,@Monto);
GO
CREATE OR ALTER PROCEDURE dbo.usp_Falla AS
  RAISERROR('Error de prueba provocado por el servicio',16,1);
GO
-- Usuarios de ejemplo
USE master;
IF SUSER_ID('app_user') IS NULL CREATE LOGIN app_user WITH PASSWORD='App_User#2026', CHECK_POLICY=OFF;
IF SUSER_ID('exprof_user') IS NULL CREATE LOGIN exprof_user WITH PASSWORD='Exprof_User#2026', CHECK_POLICY=OFF;
GRANT ALTER ANY EVENT SESSION TO exprof_user;
GRANT VIEW SERVER STATE TO exprof_user;
GO
USE ExprofTest;
IF USER_ID('app_user') IS NULL CREATE USER app_user FOR LOGIN app_user;
ALTER ROLE db_datareader ADD MEMBER app_user;
ALTER ROLE db_datawriter ADD MEMBER app_user;
GRANT EXECUTE TO app_user;
GO
