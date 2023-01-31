import { QueryInterface, DataTypes } from "sequelize";

module.exports = {
  up: (queryInterface: QueryInterface) => {
    return queryInterface.addColumn("Tickets", "estagio", {
      type: DataTypes.STRING,
      defaultValue: "aguardando"
    });
  },

  down: (queryInterface: QueryInterface) => {
    return queryInterface.removeColumn("Tickets", "estagio");
  }
};
